
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch

try:
    import pulp  # type: ignore
except ImportError:
    pulp = None  # install via: pip install pulp


# ---------------------------------------------------------------------------
# Configuration dataclasses
# ---------------------------------------------------------------------------

@dataclass
class BSSConfig:
    """Static BSS parameters for simulation and scheduling."""
    n_batteries: int = 40                  # number of swappable packs
    battery_capacity_kwh: float = 1.7      # energy per pack (kWh)
    max_charge_power_kw: float = 1.05      # max charging power per pack (kW)
    max_parallel_chargers: int = 20        # how many packs can charge at once

    # Time-of-use cost (grid price per kWh) for hours 0..23
    grid_price_per_hour: Sequence[float] = None

    def __post_init__(self):
        if self.grid_price_per_hour is None:
            # Example TOU: cheap at night, expensive at peaks
            base = np.array([0.1] * 24, dtype=float)
            # morning peak (7–10)
            base[7:11] = 0.25
            # evening peak (17–21)
            base[17:22] = 0.3
            # deep night super off-peak (0–4)
            base[0:5] = 0.05
            self.grid_price_per_hour = base.tolist()


@dataclass
class DemandProfileConfig:
    """Controls how we randomly simulate hourly swap demand (Poisson)."""
    morning_peak_hours: Tuple[int, int] = (7, 10)   # inclusive start, inclusive end
    evening_peak_hours: Tuple[int, int] = (17, 20)  # inclusive start, inclusive end
    base_offpeak_lambda: float = 0.2                # Poisson rate off-peak
    morning_lambda: float = 1.5                     # Poisson rate during morning peak
    evening_lambda: float = 1.2                     # Poisson rate during evening peak


# ---------------------------------------------------------------------------
# Swap demand and PV simulation (no real data yet)
# ---------------------------------------------------------------------------

def simulate_daily_swap_demand(
    rng: np.random.Generator,
    demand_cfg: DemandProfileConfig,
) -> np.ndarray:
    """
    Simulate hourly swap demand for one day (24 hours) using a simple Poisson model.

    Returns:
        demand[24]: number of swaps requested in each hour (0..23).
    """
    demand = np.zeros(24, dtype=int)
    for h in range(24):
        lam = demand_cfg.base_offpeak_lambda
        if demand_cfg.morning_peak_hours[0] <= h <= demand_cfg.morning_peak_hours[1]:
            lam = demand_cfg.morning_lambda
        elif demand_cfg.evening_peak_hours[0] <= h <= demand_cfg.evening_peak_hours[1]:
            lam = demand_cfg.evening_lambda
        demand[h] = rng.poisson(lam)
    return demand


def simulate_daily_pv_profile(rng: np.random.Generator) -> np.ndarray:
    """
    Simple synthetic PV profile in kWh for each hour (24 hours).
    Produces a bell-shaped curve peaking around noon with some noise.
    """
    pv = np.zeros(24, dtype=float)
    # daylight roughly 8–18
    for h in range(8, 19):
        # bell-shaped production peaking at noon
        pv[h] = max(0.0, 3.0 * np.exp(-((h - 12) ** 2) / 10.0))  # up to ~3 kWh/hour
        # add a little random variation
        pv[h] *= rng.uniform(0.8, 1.2)
    return pv


# ---------------------------------------------------------------------------
# High-level multi-day simulator
# ---------------------------------------------------------------------------

def simulate_bss_data(
    days: int,
    bss_cfg: Optional[BSSConfig] = None,
    demand_cfg: Optional[DemandProfileConfig] = None,
    seed: Optional[int] = None,
) -> pd.DataFrame:
    """
    Simulate multi-day hourly BSS operation data.

    IMPORTANT:
        - If seed is None  -> each run will be different (true "simulator").
        - If you pass a fixed seed (e.g., 42), runs will be reproducible.

    Returns a DataFrame with columns:
        day, hour,
        demand_swaps, pv_kwh_available, grid_price,
        scheduled_swaps, unmet_demand,
        soc_full_packs, energy_from_pv_kwh, energy_from_grid_kwh.
    """
    if bss_cfg is None:
        bss_cfg = BSSConfig()
    if demand_cfg is None:
        demand_cfg = DemandProfileConfig()

    rng = np.random.default_rng(seed)

    records = []

    # Start with some full inventory (e.g., 70% full)
    full_packs = 0.7 * bss_cfg.n_batteries

    for d in range(days):
        daily_demand = simulate_daily_swap_demand(rng, demand_cfg)
        pv_profile = simulate_daily_pv_profile(rng)
        prices = np.array(bss_cfg.grid_price_per_hour, dtype=float)

        for h in range(24):
            demand = int(daily_demand[h])
            pv_kwh = float(pv_profile[h])
            price = float(prices[h])

            # Naive policy: serve as many swaps as possible from full packs
            scheduled_swaps = min(demand, int(full_packs))
            unmet = demand - scheduled_swaps

            # Packs swapped out -> lose full packs
            full_packs -= scheduled_swaps

            # Try to charge as many empty packs as possible, bounded by chargers
            empty_packs = bss_cfg.n_batteries - full_packs
            max_charge_kwh_by_power = bss_cfg.max_charge_power_kw * bss_cfg.max_parallel_chargers
            max_charge_kwh_by_empty = empty_packs * bss_cfg.battery_capacity_kwh
            max_charge_kwh = min(max_charge_kwh_by_power, max_charge_kwh_by_empty)

            # Prefer PV: use PV first, then grid
            energy_from_pv = min(pv_kwh, max_charge_kwh)
            remaining_needed_for_full_power = max_charge_kwh - energy_from_pv
            energy_from_grid = max(0.0, remaining_needed_for_full_power)

            # Convert total charged energy back to equivalent full packs
            total_energy_charged = energy_from_pv + energy_from_grid
            delta_full_packs = total_energy_charged / bss_cfg.battery_capacity_kwh
            full_packs = min(bss_cfg.n_batteries, full_packs + delta_full_packs)

            records.append(
                dict(
                    day=d,
                    hour=h,
                    demand_swaps=demand,
                    pv_kwh_available=pv_kwh,
                    grid_price=price,
                    scheduled_swaps=scheduled_swaps,
                    unmet_demand=unmet,
                    soc_full_packs=full_packs,
                    energy_from_pv_kwh=energy_from_pv,
                    energy_from_grid_kwh=energy_from_grid,
                )
            )

    return pd.DataFrame.from_records(records)


# ---------------------------------------------------------------------------
# Single-day LP scheduler
# ---------------------------------------------------------------------------

def optimize_daily_schedule(
    demand: Sequence[float],
    pv_kwh_available: Sequence[float],
    bss_cfg: Optional[BSSConfig] = None,
    initial_full_packs: Optional[float] = None,
) -> pd.DataFrame:
    """
    LP-based daily scheduler for one 24-hour horizon.

    Decision variables per hour h:
        swap[h], unmet[h], inv[h], charge_pv[h], charge_grid[h]

    Objective:
        Minimize sum_h (grid_price[h] * charge_grid[h] + big_penalty * unmet[h])
    """
    if pulp is None:
        raise ImportError(
            "pulp is required for optimize_daily_schedule(). "
            "Install it via `pip install pulp`."
        )

    if bss_cfg is None:
        bss_cfg = BSSConfig()

    H = len(demand)
    if H != 24:
        raise ValueError("This example assumes a 24-hour horizon (len(demand) == 24).")

    demand = np.array(demand, dtype=float)
    pv = np.array(pv_kwh_available, dtype=float)
    prices = np.array(bss_cfg.grid_price_per_hour, dtype=float)

    if initial_full_packs is None:
        initial_full_packs = 0.7 * bss_cfg.n_batteries

    hourly_power_limit_kwh = bss_cfg.max_charge_power_kw * bss_cfg.max_parallel_chargers

    # LP model
    model = pulp.LpProblem("BSS_Daily_Schedule", pulp.LpMinimize)

    # Decision variables
    swap = pulp.LpVariable.dicts("swap", range(H), lowBound=0)
    unmet = pulp.LpVariable.dicts("unmet", range(H), lowBound=0)
    inv = pulp.LpVariable.dicts("inv", range(H + 1), lowBound=0)
    charge_pv = pulp.LpVariable.dicts("charge_pv", range(H), lowBound=0)
    charge_grid = pulp.LpVariable.dicts("charge_grid", range(H), lowBound=0)

    big_penalty = 10.0  # penalty per unmet swap

    # Objective
    model += pulp.lpSum(
        prices[h] * charge_grid[h] + big_penalty * unmet[h]
        for h in range(H)
    )

    # Initial inventory
    model += inv[0] == initial_full_packs, "Initial_inventory"

    for h in range(H):
        model += swap[h] + unmet[h] == demand[h], f"demand_balance_{h}"
        model += inv[h] >= swap[h], f"inventory_ge_swap_{h}"
        model += charge_pv[h] <= pv[h], f"pv_limit_{h}"
        model += charge_pv[h] + charge_grid[h] <= hourly_power_limit_kwh, f"power_limit_{h}"
        model += (
            inv[h + 1]
            == inv[h]
            - swap[h]
            + (charge_pv[h] + charge_grid[h]) / bss_cfg.battery_capacity_kwh
        ), f"inventory_balance_{h}"
        model += inv[h] <= bss_cfg.n_batteries, f"inventory_cap_{h}"

    model.solve(pulp.PULP_CBC_CMD(msg=False))

    rows = []
    for h in range(H):
        rows.append(
            dict(
                hour=h,
                demand=float(demand[h]),
                swap=pulp.value(swap[h]),
                unmet=pulp.value(unmet[h]),
                inv_start=pulp.value(inv[h]),
                inv_end=pulp.value(inv[h + 1]),
                charge_pv_kwh=pulp.value(charge_pv[h]),
                charge_grid_kwh=pulp.value(charge_grid[h]),
                pv_kwh_available=float(pv[h]),
                grid_price=float(prices[h]),
            )
        )

    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Weekly scheduler (NEW)
# ---------------------------------------------------------------------------

def optimize_weekly_schedule(
    demand_matrix: np.ndarray,
    pv_matrix: np.ndarray,
    bss_cfg: Optional[BSSConfig] = None,
    initial_full_packs: Optional[float] = None,
) -> pd.DataFrame:
    """
    Run the LP scheduler for a whole week (or any number of days),
    day by day, carrying inventory across days.

    demand_matrix: shape (D, 24)
    pv_matrix:     shape (D, 24)

    Returns:
        DataFrame with columns for each day:
            day, hour, demand, swap, unmet, inv_start, inv_end,
            charge_pv_kwh, charge_grid_kwh, pv_kwh_available, grid_price
    """
    if bss_cfg is None:
        bss_cfg = BSSConfig()

    demand_matrix = np.asarray(demand_matrix, dtype=float)
    pv_matrix = np.asarray(pv_matrix, dtype=float)

    if demand_matrix.shape != pv_matrix.shape:
        raise ValueError("demand_matrix and pv_matrix must have the same shape (D, 24).")

    D, H = demand_matrix.shape
    if H != 24:
        raise ValueError("Each day must have 24 hours (shape must be (D, 24)).")

    if initial_full_packs is None:
        initial_full_packs = 0.7 * bss_cfg.n_batteries

    all_days = []
    inv_start_next = initial_full_packs

    for d in range(D):
        demand_d = demand_matrix[d, :]
        pv_d = pv_matrix[d, :]

        # Run daily LP with given starting inventory
        day_sched = optimize_daily_schedule(
            demand=demand_d,
            pv_kwh_available=pv_d,
            bss_cfg=bss_cfg,
            initial_full_packs=inv_start_next,
        )
        day_sched["day"] = d

        # Inventory continuity: use last inv_end as next day's initial inventory
        inv_start_next = float(day_sched["inv_end"].iloc[-1])

        all_days.append(day_sched)

    weekly_df = pd.concat(all_days, ignore_index=True)
    return weekly_df


def optimize_weekly_schedule_from_sim(
    sim_df: pd.DataFrame,
    bss_cfg: Optional[BSSConfig] = None,
    initial_full_packs: Optional[float] = None,
) -> pd.DataFrame:
    """
    Convenience wrapper:
    - Takes simulation output (multiple days),
    - Extracts demand_swaps and pv_kwh_available per day,
    - Calls optimize_weekly_schedule.

    sim_df must contain: 'day', 'hour', 'demand_swaps', 'pv_kwh_available'.
    """
    if not {"day", "hour", "demand_swaps", "pv_kwh_available"}.issubset(sim_df.columns):
        raise ValueError(
            "sim_df must contain 'day', 'hour', 'demand_swaps', 'pv_kwh_available'."
        )

    days_sorted = sorted(sim_df["day"].unique())
    D = len(days_sorted)

    demand_matrix = np.zeros((D, 24), dtype=float)
    pv_matrix = np.zeros((D, 24), dtype=float)

    for i, d in enumerate(days_sorted):
        day_df = sim_df[sim_df["day"] == d]
        # Assume one row per hour
        day_df = day_df.sort_values("hour")
        demand_matrix[i, :] = day_df["demand_swaps"].values
        pv_matrix[i, :] = day_df["pv_kwh_available"].values

    weekly_df = optimize_weekly_schedule(
        demand_matrix=demand_matrix,
        pv_matrix=pv_matrix,
        bss_cfg=bss_cfg,
        initial_full_packs=initial_full_packs,
    )

    return weekly_df


# ---------------------------------------------------------------------------
# ML prediction stub + forecast-integrated scheduler
# ---------------------------------------------------------------------------

def predict_swaps_ml_stub(history_df: pd.DataFrame) -> np.ndarray:
    """
    Placeholder for future time-series ML model.

    Right now: average demand per hour-of-day over history_df.
    """
    if "hour" not in history_df.columns or "demand_swaps" not in history_df.columns:
        raise ValueError("history_df must contain 'hour' and 'demand_swaps' columns.")

    hourly_mean = (
        history_df.groupby("hour")["demand_swaps"].mean().reindex(range(24), fill_value=0.0)
    )
    return hourly_mean.values


def forecast_next_day_demand_stub(history_df: pd.DataFrame) -> np.ndarray:
    """
    Tiny wrapper around predict_swaps_ml_stub().
    """
    return predict_swaps_ml_stub(history_df)


def optimize_daily_schedule_with_forecast(
    history_df: pd.DataFrame,
    pv_kwh_available: Sequence[float],
    bss_cfg: Optional[BSSConfig] = None,
    initial_full_packs: Optional[float] = None,
    realized_demand: Optional[Sequence[int]] = None,
) -> pd.DataFrame:
    """
    Forecast-integrated scheduler for a single day:

    1. Use history_df to forecast next-day demand (24h).
    2. Run optimize_daily_schedule using the forecast.
    3. Optionally attach realized_demand and forecast errors.
    """
    forecast_demand = forecast_next_day_demand_stub(history_df)

    schedule_df = optimize_daily_schedule(
        demand=forecast_demand,
        pv_kwh_available=pv_kwh_available,
        bss_cfg=bss_cfg,
        initial_full_packs=initial_full_packs,
    )

    schedule_df = schedule_df.rename(columns={"demand": "forecast_demand"})

    if realized_demand is not None:
        realized_demand = np.asarray(realized_demand, dtype=float)
        if realized_demand.shape[0] != 24:
            raise ValueError("realized_demand must be length 24.")
        schedule_df["realized_demand"] = realized_demand
        schedule_df["forecast_error"] = (
            schedule_df["forecast_demand"] - schedule_df["realized_demand"]
        )
        schedule_df["abs_forecast_error"] = schedule_df["forecast_error"].abs()

    return schedule_df


# ---------------------------------------------------------------------------
# Plotting helpers (optional)
# ---------------------------------------------------------------------------

def plot_daily_results(
    df: pd.DataFrame,
    title: str = "BSS Daily Results",
    save_path: Optional[str] = None,
    show: bool = True,
):
    """Line plot: demand / swaps / unmet + SoC/inventory."""
    if "hour" not in df.columns:
        raise ValueError("df must contain an 'hour' column (0..23).")

    hours = df["hour"].values
    fig, ax1 = plt.subplots(figsize=(10, 5))

    if "demand_swaps" in df.columns:
        ax1.plot(hours, df["demand_swaps"].values, marker="o", label="Demand (sim)")
    if "forecast_demand" in df.columns:
        ax1.plot(hours, df["forecast_demand"].values, marker="o", linestyle="--", label="Forecast Demand")
    if "realized_demand" in df.columns:
        ax1.plot(hours, df["realized_demand"].values, marker="x", linestyle=":", label="Realized Demand")
    if "swap" in df.columns:
        ax1.plot(hours, df["swap"].values, marker="s", label="Served Swaps (schedule)")
    if "scheduled_swaps" in df.columns:
        ax1.plot(hours, df["scheduled_swaps"].values, marker="s", linestyle="-.", label="Served Swaps (sim)")
    if "unmet" in df.columns:
        ax1.plot(hours, df["unmet"].values, marker="v", linestyle=":", label="Unmet Demand")

    ax1.set_xlabel("Hour of day")
    ax1.set_ylabel("Swaps / Demand")
    ax1.set_xticks(range(0, 24, 2))

    ax2 = ax1.twinx()
    if "soc_full_packs" in df.columns:
        ax2.plot(hours, df["soc_full_packs"].values, linestyle="--", alpha=0.7, label="SoC (full packs)")
    elif "inv_end" in df.columns:
        ax2.plot(hours, df["inv_end"].values, linestyle="--", alpha=0.7, label="Inventory (full packs)")
    ax2.set_ylabel("Full packs")

    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, loc="upper right")

    ax1.set_title(title)
    fig.tight_layout()
    if save_path is not None:
        fig.savefig(save_path, dpi=150)
    if show:
        plt.show()
    return fig


def add_status_column(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add 'status' per hour:
        idle / charge / swap / swap+charge
    """
    df = df.copy()
    swap_col = "swap" if "swap" in df.columns else "scheduled_swaps"
    pv_col = "charge_pv_kwh" if "charge_pv_kwh" in df.columns else "energy_from_pv_kwh"
    grid_col = "charge_grid_kwh" if "charge_grid_kwh" in df.columns else "energy_from_grid_kwh"

    statuses = []
    for _, row in df.iterrows():
        swapping = row.get(swap_col, 0.0) > 1e-6
        charging = (row.get(pv_col, 0.0) + row.get(grid_col, 0.0)) > 1e-6
        if swapping and charging:
            status = "swap+charge"
        elif swapping:
            status = "swap"
        elif charging:
            status = "charge"
        else:
            status = "idle"
        statuses.append(status)
    df["status"] = statuses
    return df


def plot_daily_status_blocks(
    df: pd.DataFrame,
    title: str = "BSS Day Schedule (Charging / Swapping / Idle)",
    save_path: Optional[str] = None,
    show: bool = True,
):
    """1D strip: status per hour for a single day."""
    if "hour" not in df.columns:
        raise ValueError("df must contain an 'hour' column (0..23).")
    if "status" not in df.columns:
        df = add_status_column(df)

    status_order = ["idle", "charge", "swap", "swap+charge"]
    status_to_int = {s: i for i, s in enumerate(status_order)}

    hours = df["hour"].values
    status_ints = np.array([status_to_int[s] for s in df["status"]])
    cmap = ListedColormap(["#d3d3d3", "#4caf50", "#2196f3", "#ff9800"])

    fig, ax = plt.subplots(figsize=(10, 1.5))
    strip = status_ints.reshape(1, -1)
    ax.imshow(strip, aspect="auto", cmap=cmap)
    ax.set_yticks([])
    ax.set_xticks(range(24))
    ax.set_xticklabels(range(24))
    ax.set_xlabel("Hour of day")
    ax.set_title(title)

    legend_handles = [Patch(color=cmap(status_to_int[s]), label=s) for s in status_order]
    ax.legend(handles=legend_handles, bbox_to_anchor=(1.02, 1), loc="upper left", borderaxespad=0.0)

    fig.tight_layout()
    if save_path is not None:
        fig.savefig(save_path, dpi=150, bbox_inches="tight")
    if show:
        plt.show()
    return fig


def plot_weekly_status_blocks(
    df: pd.DataFrame,
    title: str = "BSS Weekly Status (Charging / Swapping / Idle)",
    day_col: str = "day",
    save_path: Optional[str] = None,
    show: bool = True,
):
    """2D grid: days × hours, status colored."""
    if "hour" not in df.columns:
        raise ValueError("df must contain an 'hour' column.")
    if day_col not in df.columns:
        raise ValueError(f"df must contain '{day_col}' column.")

    if "status" not in df.columns:
        df = add_status_column(df)

    status_order = ["idle", "charge", "swap", "swap+charge"]
    status_to_int = {s: i for i, s in enumerate(status_order)}
    days_sorted = sorted(df[day_col].unique())
    n_days = len(days_sorted)
    n_hours = 24

    mat = np.full((n_days, n_hours), -1, dtype=int)
    for i, d in enumerate(days_sorted):
        day_df = df[df[day_col] == d]
        for _, row in day_df.iterrows():
            h = int(row["hour"])
            if 0 <= h < n_hours:
                mat[i, h] = status_to_int[row["status"]]
    idle_idx = status_to_int["idle"]
    mat[mat < 0] = idle_idx

    cmap = ListedColormap(["#d3d3d3", "#4caf50", "#2196f3", "#ff9800"])
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.imshow(mat, aspect="auto", cmap=cmap)
    ax.set_xticks(range(n_hours))
    ax.set_xticklabels(range(n_hours))
    ax.set_xlabel("Hour of day")
    ax.set_yticks(range(n_days))
    ax.set_yticklabels([f"Day {d}" for d in days_sorted])
    ax.set_ylabel("Day index")
    ax.set_title(title)

    legend_handles = [Patch(color=cmap(status_to_int[s]), label=s) for s in status_order]
    ax.legend(handles=legend_handles, bbox_to_anchor=(1.02, 1), loc="upper left", borderaxespad=0.0)

    fig.tight_layout()
    if save_path is not None:
        fig.savefig(save_path, dpi=150, bbox_inches="tight")
    if show:
        plt.show()
    return fig


# ---------------------------------------------------------------------------
# Example usage
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Simulate 7 days
    sim_df = simulate_bss_data(days=7, seed=None)
    print("Simulated data (head):")
    print(sim_df.head())

    # --- Single-day scheduler example (day 0) ---
    day0_sim = sim_df[sim_df["day"] == 0].reset_index(drop=True)
    demand_0 = day0_sim["demand_swaps"].astype(float).tolist()
    pv_0 = day0_sim["pv_kwh_available"].astype(float).tolist()

    day0_sched = optimize_daily_schedule(demand_0, pv_0)
    day0_sched["day"] = 0
    print("\nOptimized daily schedule (day 0, head):")
    print(day0_sched.head())

    # --- Weekly scheduler example (continuous inventory across 7 days) ---
    weekly_sched = optimize_weekly_schedule_from_sim(sim_df)
    print("\nWeekly optimized schedule (head):")
    print(weekly_sched.head())

    # Optional plots
    plot_daily_results(day0_sim, title="Simulated Day 0 (Naive Control)")
    plot_daily_results(day0_sched, title="Optimized Day 0 (LP Scheduler)")
    plot_daily_status_blocks(day0_sched, title="Optimized Day 0 Status")
    plot_weekly_status_blocks(weekly_sched, title="Weekly Optimized Status")
