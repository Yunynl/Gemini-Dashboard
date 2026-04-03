"""
 Per-Pack Polynomial Regression

Generates a separate 3rd-order polynomial SoC(V_pack) formula for each
battery pack configuration based on a master cell lookup table and the
pack's series count.

Master cell lookup table (from 21700 datasheet):
    V_cell: 3.2V - 4.2V (11 points)
    SoC:    0%   - 100%

For each pack config the cell voltages are scaled by the series count
to get pack-level voltages, then a 3rd-order polynomial is fit on
(V_pack, SoC) data.

Usage:
    python battery_soc_calculator.py
    python battery_soc_calculator.py --series 13 --voltage 48.5
    python battery_soc_calculator.py --series 20
"""

import numpy as np
import matplotlib.pyplot as plt
import argparse
import os

# ── Master Cell Lookup Table (from 21700 datasheet) ─────────────────────
CELL_SOC_PERCENT = np.array([100, 93.2, 81.8, 69.4, 55.0, 28.0, 22.2, 11.4, 6.0, 1.2, 0.0])
CELL_VOLTAGE_V   = np.array([4.2, 4.1,  4.0,  3.9,  3.8,  3.7,  3.6,  3.5,  3.4, 3.3, 3.2])

# ── Pack Configurations ─────────────────────────────────────────────────
PACK_CONFIGS = {
    "bike_battery_13S": 13,
    "swap_battery_17S": 17,
}


def scale_voltage_for_pack(series_count):
    """Scale cell voltages to pack voltages: V_pack = V_cell * series_count."""
    return CELL_VOLTAGE_V * series_count


def fit_polynomial(pack_voltages, soc_values, degree=3):
    """Fit a polynomial of given degree to (voltage, SoC) data."""
    coeffs = np.polyfit(pack_voltages, soc_values, degree)
    return coeffs


def format_formula(coeffs, var_name="V"):
    """Format polynomial coefficients as a human-readable formula string."""
    terms = []
    degree = len(coeffs) - 1
    for i, c in enumerate(coeffs):
        power = degree - i
        if power == 0:
            terms.append(f"{c:.6f}")
        elif power == 1:
            terms.append(f"{c:.6f} * {var_name}")
        else:
            terms.append(f"{c:.6f} * {var_name}^{power}")
    return "SoC(%) = " + " + ".join(terms)


def estimate_soc(coeffs, voltage):
    """Evaluate the polynomial at a given pack voltage."""
    poly = np.poly1d(coeffs)
    soc = poly(voltage)
    return max(0.0, min(100.0, round(soc, 2)))


def print_pack_report(name, series_count, coeffs, pack_voltages):
    """Print a detailed report for one pack configuration."""
    poly = np.poly1d(coeffs)
    predicted = poly(pack_voltages)
    predicted_clamped = np.clip(predicted, 0, 100)

    ss_res = np.sum((CELL_SOC_PERCENT - predicted) ** 2)
    ss_tot = np.sum((CELL_SOC_PERCENT - CELL_SOC_PERCENT.mean()) ** 2)
    r_squared = 1 - ss_res / ss_tot
    rmse = np.sqrt(np.mean((CELL_SOC_PERCENT - predicted) ** 2))
    max_err = np.max(np.abs(CELL_SOC_PERCENT - predicted))

    print(f"\n{'=' * 60}")
    print(f"  Pack: {name}  ({series_count}S)")
    print(f"{'=' * 60}")
    print(f"  Voltage range: {pack_voltages.min():.1f}V - {pack_voltages.max():.1f}V")
    print(f"\n  {format_formula(coeffs, 'V')}")
    print(f"\n  Coefficients: [{', '.join(f'{c:.10f}' for c in coeffs)}]")
    print(f"\n  R^2       = {r_squared:.6f}")
    print(f"  RMSE      = {rmse:.4f}%")
    print(f"  Max error = {max_err:.4f}%")

    print(f"\n  {'V_pack':>10}  {'SoC_actual':>10}  {'SoC_pred':>10}  {'Error':>10}")
    print(f"  {'-'*10}  {'-'*10}  {'-'*10}  {'-'*10}")
    for v, actual, pred in zip(pack_voltages, CELL_SOC_PERCENT, predicted_clamped):
        print(f"  {v:10.1f}  {actual:10.1f}  {pred:10.2f}  {actual - pred:+10.2f}")

    return r_squared, rmse, max_err


def plot_results(all_results):
    """Plot SoC curves for all pack configurations."""
    n = len(all_results)
    fig, axes = plt.subplots(1, n, figsize=(7 * n, 6))
    if n == 1:
        axes = [axes]

    for ax, (name, series, coeffs, pack_v) in zip(axes, all_results):
        poly = np.poly1d(coeffs)
        v_smooth = np.linspace(pack_v.min(), pack_v.max(), 200)
        soc_smooth = np.clip(poly(v_smooth), 0, 100)

        ax.scatter(pack_v, CELL_SOC_PERCENT, s=60, zorder=5,
                   color='steelblue', label='Lookup table points')
        ax.plot(v_smooth, soc_smooth, 'r-', linewidth=2,
                label='3rd-order polynomial fit')
        ax.set_xlabel('Pack Voltage (V)', fontsize=12)
        ax.set_ylabel('State of Charge (%)', fontsize=12)
        ax.set_title(f'{name} ({series}S)', fontsize=14)
        ax.legend(fontsize=10)
        ax.grid(True, alpha=0.3)
        ax.set_ylim(-5, 105)

    plt.tight_layout()
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'soc_curves.png')
    plt.savefig(out_path, dpi=150)
    print(f"\nPlot saved to: {out_path}")
    plt.show()


def main():
    parser = argparse.ArgumentParser(description='Battery SoC Calculator — Per-Pack Polynomial')
    parser.add_argument('--series', type=int, help='Estimate SoC for a custom series count')
    parser.add_argument('--voltage', type=float, help='Pack voltage to estimate SoC for (requires --series)')
    args = parser.parse_args()

    # ── Single voltage estimation mode ───────────────────────────────────
    if args.series and args.voltage:
        pack_v = scale_voltage_for_pack(args.series)
        coeffs = fit_polynomial(pack_v, CELL_SOC_PERCENT)
        soc = estimate_soc(coeffs, args.voltage)
        print(f"Pack: {args.series}S, Voltage: {args.voltage}V -> SoC: {soc}%")
        return

    # ── Full report mode ─────────────────────────────────────────────────
    all_results = []

    # Add custom series from CLI if provided
    configs = dict(PACK_CONFIGS)
    if args.series and not args.voltage:
        configs[f"custom_{args.series}S"] = args.series

    print("Battery SoC Calculator — Per-Pack Polynomial Regression")
    print("Master cell lookup table: 21700 (3.2V - 4.2V, 11 points)")

    for name, series in configs.items():
        pack_v = scale_voltage_for_pack(series)
        coeffs = fit_polynomial(pack_v, CELL_SOC_PERCENT)
        print_pack_report(name, series, coeffs, pack_v)
        all_results.append((name, series, coeffs, pack_v))

    # ── Print JavaScript snippets ────────────────────────────────────────
    print(f"\n{'=' * 60}")
    print("JavaScript Coefficients (paste into bss_logic.js)")
    print(f"{'=' * 60}")
    for name, series, coeffs, _ in all_results:
        print(f"\n// {name} ({series}S)")
        print(f"// {format_formula(coeffs, 'V')}")
        print(f"socCoeffs: [{', '.join(f'{c}' for c in coeffs)}]")

    plot_results(all_results)


if __name__ == '__main__':
    main()
