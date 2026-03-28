
const DEFAULT_CONFIG = {
    // Google Script URL
    url: "https://script.google.com/macros/s/AKfycbxWgnqV5zJ7IoN4zpLS16Kju4OfkvddtzxcwPNmBAmdAjHxhzS-Xywce6kRI1UwH3tebw/exec",

    // [Requirement 2] Cell Definitions (21700 3.7V-4.2V 5Ah)
    cells: [
        { id: 'c1', name: '21700 Standard', vMin: 3.0, vMax: 4.2, ah: 5.0 }
    ],

    // [Requirement 3] Pack Definitions
    // User inputs Series & Total Mfg Capacity. System calculates Parallel.
    packs: [
        { id: 'p1', name: 'SWAP Bike Pack', cellId: 'c1', series: 17, mfgAh: 85.0, referenceFullWh: null, referenceSocWhCurve: [], referenceTelemetry: [], referenceLabel: 'Hardcoded SWAP Battery 11_26 Charge' }
    ],

    // [Requirement 1] Slot Mapping
    slots: [
        { id: 1, name: 'SWAP Unit', packId: 'p1', colVol: 2, colAmp: 3, colStat: 4, colSoc: 5 }
    ],

    // SoH uses this partial SoC window when enough telemetry is available
    sohWindow: { socLow: 10, socHigh: 50, minSpanSoc: 15 }
};

let SYSTEM_CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let AppState = {
    currentView: 'station',
    processedData: {},
    cycleHistory: [],
    slotStates: {},
    activeLogData: [],
    filteredLogData: [],
    currentPage: 1,
    updateInterval: null,
    chartInstance: null,
    referenceChartInstance: null,
    cycleChartInstance: null,
    selectedCycleBySlot: {},
    analysisStats: null,
    minTableFilter: 'ALL',
    minTableWindow: 1
};
let alertSent = false;
const ROWS_PER_PAGE = 50;

const HARD_CODED_REFERENCE_PROFILE = {
    label: 'SWAP Battery 11_26 Charging using 200W Charger',
    source: 'Battery Monitoring (UPDATED) - SWAP Battery 11_26 Charging using 200W Charger.csv',
    estimatedFullWh: 936.38,
    estimatedFullAh: 14.0162,
    telemetry: [
        { timeS: 10, soc: 2.89, voltageV: 56.7, currentA: 3.13, powerW: 177.47, cumAh: 0, cumWh: 0 },
        { timeS: 43, soc: 5, voltageV: 57.45, currentA: 2.901, powerW: 166.65, cumAh: 0.0267, cumWh: 1.53 },
        { timeS: 144.8, soc: 10, voltageV: 59.06, currentA: 2.86, powerW: 168.91, cumAh: 0.1108, cumWh: 6.44 },
        { timeS: 229.5, soc: 15, voltageV: 60.07, currentA: 3.048, powerW: 183.11, cumAh: 0.1797, cumWh: 10.53 },
        { timeS: 324.5, soc: 20, voltageV: 60.85, currentA: 3.053, powerW: 185.81, cumAh: 0.2579, cumWh: 15.27 },
        { timeS: 433.9, soc: 25, voltageV: 61.51, currentA: 3, powerW: 184.56, cumAh: 0.3492, cumWh: 20.84 },
        { timeS: 508.2, soc: 30, voltageV: 62.06, currentA: 2.964, powerW: 183.93, cumAh: 0.4094, cumWh: 24.56 },
        { timeS: 642.7, soc: 35, voltageV: 62.61, currentA: 3.074, powerW: 192.46, cumAh: 0.5193, cumWh: 31.4 },
        { timeS: 756.1, soc: 40, voltageV: 63.13, currentA: 2.82, powerW: 178.04, cumAh: 0.6108, cumWh: 37.16 },
        { timeS: 867.5, soc: 45, voltageV: 63.62, currentA: 2.85, powerW: 181.3, cumAh: 0.7002, cumWh: 42.81 },
        { timeS: 989.6, soc: 50, voltageV: 64.11, currentA: 3.031, powerW: 194.33, cumAh: 0.7988, cumWh: 49.11 },
        { timeS: 1221.6, soc: 55, voltageV: 64.61, currentA: 2.864, powerW: 185.03, cumAh: 0.9884, cumWh: 61.3 },
        { timeS: 1397.4, soc: 60, voltageV: 65.19, currentA: 2.832, powerW: 184.63, cumAh: 1.1313, cumWh: 70.58 },
        { timeS: 3013.5, soc: 65, voltageV: 65.78, currentA: 2.82, powerW: 185.5, cumAh: 2.4366, cumWh: 156.09 },
        { timeS: 4670.1, soc: 70, voltageV: 66.38, currentA: 2.82, powerW: 187.19, cumAh: 3.7793, cumWh: 244.74 },
        { timeS: 6480.8, soc: 75, voltageV: 67.07, currentA: 2.833, powerW: 190.02, cumAh: 5.2466, cumWh: 342.62 },
        { timeS: 9535.6, soc: 80, voltageV: 67.75, currentA: 2.879, powerW: 195.09, cumAh: 7.7103, cumWh: 508.22 },
        { timeS: 13526.7, soc: 85, voltageV: 68.48, currentA: 2.767, powerW: 189.46, cumAh: 10.8605, cumWh: 722.5 },
        { timeS: 14666.6, soc: 90, voltageV: 69.22, currentA: 2.66, powerW: 184.13, cumAh: 11.7517, cumWh: 783.51 },
        { timeS: 15390, soc: 90.52, voltageV: 69.75, currentA: 2.66, powerW: 185.54, cumAh: 12.2824, cumWh: 820.55 }
    ]
};

const Physics = {
    calculatePackSpecs: (packCfg, cellCfg) => {
        // P = Total Mfg Ah / Cell Ah
        const parallel = (packCfg.mfgAh / cellCfg.ah).toFixed(1);

        const maxV = cellCfg.vMax * packCfg.series;
        const minV = cellCfg.vMin * packCfg.series;

        const idealWh = packCfg.mfgAh * maxV;

        return {
            series: packCfg.series,
            parallel: parallel, // Calculated P
            minV: minV,
            maxV: maxV,
            idealWh: idealWh
        };
    },

    // SoH = Estimated 100% Wh / Factory Ideal Wh
    calculateSoH: (measuredWh, startSoc, endSoc, idealTotalWh) => {
        const deltaSoc = Math.abs(startSoc - endSoc) / 100; // e.g. 0.5 for 50% change

        if (deltaSoc < 0.15) return "--";

        const estimatedFullCapacityWh = measuredWh / deltaSoc;

        let soh = (estimatedFullCapacityWh / idealTotalWh) * 100;

        return Math.min(100, Math.max(0, soh)).toFixed(1);
    },

    calculateTrapezoidalEnergy: (history) => {
        if (history.length < 2) return 0;
        let wh = 0;
        for (let i = 1; i < history.length; i++) {
            const curr = history[i];
            const prev = history[i - 1];

            const dt = (curr.timestamp - prev.timestamp) / 3600000;

            if (dt > 0 && dt < 1) {
                const p1 = prev.vol * Math.abs(prev.amp);
                const p2 = curr.vol * Math.abs(curr.amp);
                wh += ((p1 + p2) / 2) * dt;
            }
        }
        return wh;
    },

    calculateTrapezoidalChargeAh: (history) => {
        if (history.length < 2) return 0;
        let ah = 0;
        for (let i = 1; i < history.length; i++) {
            const curr = history[i];
            const prev = history[i - 1];
            const dt = (curr.timestamp - prev.timestamp) / 3600000;
            if (dt > 0 && dt < 1) {
                ah += ((Math.abs(prev.amp) + Math.abs(curr.amp)) / 2) * dt;
            }
        }
        return ah;
    },

    normalizeStatus: (status) => {
        const s = String(status || 'IDLE').toUpperCase();
        if (s.includes('CHARG')) return 'CHARGING';
        if (s.includes('DISCH')) return 'DISCHARGING';
        return 'IDLE';
    },

    // Classify idle sub-types and detect fake charging/discharging.
    // Returns: CHARGING, DISCHARGING, REAL_IDLE, STICKY_RELAY_IDLE, CHARGING_IDLE, DISCHARGING_IDLE
    classifyState: (status, current, prevSoc, currSoc) => {
        const amp = Math.abs(current || 0);
        const socDelta = (currSoc != null && prevSoc != null) ? currSoc - prevSoc : null;

        if (status === 'IDLE') {
            return amp >= 0.1 ? 'STICKY_RELAY_IDLE' : 'REAL_IDLE';
        }
        if (status === 'CHARGING') {
            // Charging but SoC not increasing (or dropping) → fake charge
            if (socDelta !== null && socDelta <= 0 && amp < 0.1) return 'CHARGING_IDLE';
            return 'CHARGING';
        }
        if (status === 'DISCHARGING') {
            // Discharging but SoC not decreasing (or rising) → fake discharge
            if (socDelta !== null && socDelta >= 0 && amp < 0.1) return 'DISCHARGING_IDLE';
            return 'DISCHARGING';
        }
        return 'REAL_IDLE';
    },

    // Get badge CSS class and display label for a detailed status
    statusBadgeInfo: (detailedStatus) => {
        switch (detailedStatus) {
            case 'CHARGING':          return { cls: 'st-charge', label: 'CHARGING' };
            case 'DISCHARGING':       return { cls: 'st-discharge', label: 'DISCHARGING' };
            case 'STICKY_RELAY_IDLE': return { cls: 'st-sticky-relay', label: 'STUCK RELAY' };
            case 'CHARGING_IDLE':     return { cls: 'st-charging-idle', label: 'CHG IDLE' };
            case 'DISCHARGING_IDLE':  return { cls: 'st-discharging-idle', label: 'DCH IDLE' };
            case 'REAL_IDLE':
            default:                  return { cls: 'st-idle', label: 'IDLE' };
        }
    },

    interpolateAtSoc: (a, b, targetSoc) => {
        const s1 = a.soc;
        const s2 = b.soc;
        if (isNaN(s1) || isNaN(s2)) return null;
        if (s1 === s2) {
            if (targetSoc !== s1) return null;
            return { timestamp: a.timestamp, vol: a.vol, amp: a.amp, soc: targetSoc };
        }

        const minS = Math.min(s1, s2);
        const maxS = Math.max(s1, s2);
        if (targetSoc < minS || targetSoc > maxS) return null;

        const ratio = (targetSoc - s1) / (s2 - s1);
        const lerp = (x, y) => x + (y - x) * ratio;
        return {
            timestamp: lerp(a.timestamp, b.timestamp),
            vol: lerp(a.vol, b.vol),
            amp: lerp(a.amp, b.amp),
            soc: targetSoc
        };
    },

    extractSocWindowHistory: (history, socLow, socHigh) => {
        if (!Array.isArray(history) || history.length < 2) return null;

        const firstSoc = history[0].soc;
        const lastSoc = history[history.length - 1].soc;
        const increasing = lastSoc >= firstSoc;
        const startTarget = increasing ? Math.min(socLow, socHigh) : Math.max(socLow, socHigh);
        const endTarget = increasing ? Math.max(socLow, socHigh) : Math.min(socLow, socHigh);

        let startPoint = null;
        let endPoint = null;
        let startPairIdx = -1;
        let endPairIdx = -1;

        for (let i = 1; i < history.length; i++) {
            const p = Physics.interpolateAtSoc(history[i - 1], history[i], startTarget);
            if (p) {
                startPoint = p;
                startPairIdx = i;
                break;
            }
        }
        if (!startPoint) return null;

        for (let i = startPairIdx; i < history.length; i++) {
            const p = Physics.interpolateAtSoc(history[i - 1], history[i], endTarget);
            if (p) {
                endPoint = p;
                endPairIdx = i;
                break;
            }
        }
        if (!endPoint) return null;

        const segment = [startPoint];
        for (let i = startPairIdx; i < endPairIdx; i++) segment.push(history[i]);
        segment.push(endPoint);
        return segment;
    },

    referenceWhForSocWindow: (packCfg, packSpecs, socLow, socHigh) => {
        const spanSoc = Math.abs(socHigh - socLow);
        if (spanSoc <= 0) return 0;

        const curve = Array.isArray(packCfg.referenceSocWhCurve) ? packCfg.referenceSocWhCurve : [];
        if (curve.length >= 2) {
            const points = [...curve]
                .map(p => ({ soc: parseFloat(p.soc), wh: parseFloat(p.wh) }))
                .filter(p => !isNaN(p.soc) && !isNaN(p.wh))
                .sort((a, b) => a.soc - b.soc);
            if (points.length >= 2) {
                const interpWh = (soc) => {
                    const s = Math.max(points[0].soc, Math.min(points[points.length - 1].soc, soc));
                    for (let i = 1; i < points.length; i++) {
                        const a = points[i - 1], b = points[i];
                        if (s >= a.soc && s <= b.soc) {
                            if (b.soc === a.soc) return a.wh;
                            const r = (s - a.soc) / (b.soc - a.soc);
                            return a.wh + (b.wh - a.wh) * r;
                        }
                    }
                    return points[points.length - 1].wh;
                };
                return Math.abs(interpWh(socHigh) - interpWh(socLow));
            }
        }

        const fullWh = (typeof packCfg.referenceFullWh === 'number' && packCfg.referenceFullWh > 0)
            ? packCfg.referenceFullWh
            : packSpecs.idealWh;
        return fullWh * (spanSoc / 100);
    },

    getReferenceTelemetry: (packCfg) => {
        return Array.isArray(packCfg?.referenceTelemetry) ? packCfg.referenceTelemetry : [];
    },

    interpolateReferencePoint: (packCfg, targetSoc) => {
        const REF_SERIES = 17; // reference profile was recorded on a 17S pack
        const seriesScale = (packCfg && packCfg.series > 0) ? (packCfg.series / REF_SERIES) : 1;

        const scalePoint = (pt) => ({
            ...pt,
            voltageV: pt.voltageV * seriesScale,
            powerW:   pt.powerW   * seriesScale,
            cumWh:    pt.cumWh    * seriesScale,
            // cumAh and currentA don't scale with series count
        });

        const points = Physics.getReferenceTelemetry(packCfg);
        if (!points.length || !Number.isFinite(targetSoc)) return null;
        const sorted = [...points].sort((a, b) => a.soc - b.soc);
        if (targetSoc <= sorted[0].soc) return scalePoint({ ...sorted[0] });
        if (targetSoc >= sorted[sorted.length - 1].soc) {
            const last = sorted[sorted.length - 1];
            const fullWh = (typeof packCfg.referenceFullWh === 'number' && packCfg.referenceFullWh > last.cumWh)
                ? packCfg.referenceFullWh : last.cumWh;
            const fullAh = (typeof packCfg.referenceFullAh === 'number' && packCfg.referenceFullAh > last.cumAh)
                ? packCfg.referenceFullAh : last.cumAh;
            const remainSoc = 100 - last.soc;
            if (remainSoc <= 0) return scalePoint({ ...last });
            const ratio = Math.min(1, (targetSoc - last.soc) / remainSoc);
            return scalePoint({
                ...last,
                soc: targetSoc,
                cumWh: last.cumWh + ratio * (fullWh - last.cumWh),
                cumAh: last.cumAh + ratio * (fullAh - last.cumAh)
            });
        }
        for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1];
            const b = sorted[i];
            if (targetSoc >= a.soc && targetSoc <= b.soc) {
                if (b.soc === a.soc) return scalePoint({ ...a });
                const ratio = (targetSoc - a.soc) / (b.soc - a.soc);
                const lerp = (x, y) => x + (y - x) * ratio;
                return scalePoint({
                    timeS: lerp(a.timeS, b.timeS),
                    soc: targetSoc,
                    voltageV: lerp(a.voltageV, b.voltageV),
                    currentA: lerp(a.currentA, b.currentA),
                    powerW: lerp(a.powerW, b.powerW),
                    cumAh: lerp(a.cumAh, b.cumAh),
                    cumWh: lerp(a.cumWh, b.cumWh)
                });
            }
        }
        return scalePoint({ ...sorted[sorted.length - 1] });
    },

    referenceDeltaForSocWindow: (packCfg, startSoc, endSoc) => {
        const start = Physics.interpolateReferencePoint(packCfg, startSoc);
        const end = Physics.interpolateReferencePoint(packCfg, endSoc);
        if (!start || !end) return { deltaWh: 0, deltaAh: 0, start: null, end: null };
        return {
            deltaWh: Math.abs(end.cumWh - start.cumWh),
            deltaAh: Math.abs(end.cumAh - start.cumAh),
            start,
            end
        };
    },

    // 3rd-order polynomial SoC from per-cell voltage.
    // Derived from: SoC% = -0.04004*Vpack³ + 7.76563*Vpack² - 492.91*Vpack + 10281.84 (17S)
    // Converted to per-cell coefficients so it adapts to any series count.
    // Uncertainty: ±2.20%
    voltageToSoc: (packVoltage, seriesCount) => {
        if (!Number.isFinite(packVoltage) || !seriesCount || seriesCount <= 0) return 0;
        const v = packVoltage / seriesCount;
        const soc = -196.7165 * v * v * v + 2244.267 * v * v - 8379.47 * v + 10281.84;
        return Math.max(0, Math.min(100, Math.round(soc * 100) / 100));
    },

    estimateSocFromReferenceVoltage: (packCfg, vol, packSpecs) => {
        if (!Number.isFinite(vol)) return Physics.calculateSoC(vol, packSpecs.minV, packSpecs.maxV);
        return Physics.voltageToSoc(vol, packCfg.series);
    },

    interpolateReferencePointByTime: (packCfg, targetTimeS) => {
        const points = Physics.getReferenceTelemetry(packCfg)
            .map(p => ({
                timeS: Number(p.timeS),
                soc: Number(p.soc),
                voltageV: Number(p.voltageV),
                currentA: Number(p.currentA),
                powerW: Number(p.powerW),
                cumAh: Number(p.cumAh),
                cumWh: Number(p.cumWh)
            }))
            .filter(p => Number.isFinite(p.timeS))
            .sort((a, b) => a.timeS - b.timeS);
        if (!points.length || !Number.isFinite(targetTimeS)) return null;
        if (targetTimeS <= points[0].timeS) return { ...points[0] };
        if (targetTimeS >= points[points.length - 1].timeS) {
            const a = points[points.length - 2];
            const b = points[points.length - 1];
            if (b.timeS === a.timeS) return { ...b };
            const ratio = (targetTimeS - a.timeS) / (b.timeS - a.timeS);
            const lerp = (x, y) => x + (y - x) * ratio;
            const fullWh = (typeof packCfg.referenceFullWh === 'number' && packCfg.referenceFullWh > b.cumWh) ? packCfg.referenceFullWh : null;
            return {
                timeS: targetTimeS,
                soc: Math.max(0, Math.min(100, lerp(a.soc, b.soc))),
                voltageV: lerp(a.voltageV, b.voltageV),
                currentA: Math.max(0, lerp(a.currentA, b.currentA)),
                powerW: Math.max(0, lerp(a.powerW, b.powerW)),
                cumAh: Math.max(b.cumAh, lerp(a.cumAh, b.cumAh)),
                cumWh: fullWh != null ? Math.min(fullWh, Math.max(b.cumWh, lerp(a.cumWh, b.cumWh))) : Math.max(b.cumWh, lerp(a.cumWh, b.cumWh))
            };
        }
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1];
            const b = points[i];
            if (targetTimeS >= a.timeS && targetTimeS <= b.timeS) {
                if (b.timeS === a.timeS) return { ...a };
                const ratio = (targetTimeS - a.timeS) / (b.timeS - a.timeS);
                const lerp = (x, y) => x + (y - x) * ratio;
                return {
                    timeS: targetTimeS,
                    soc: lerp(a.soc, b.soc),
                    voltageV: lerp(a.voltageV, b.voltageV),
                    currentA: lerp(a.currentA, b.currentA),
                    powerW: lerp(a.powerW, b.powerW),
                    cumAh: lerp(a.cumAh, b.cumAh),
                    cumWh: lerp(a.cumWh, b.cumWh)
                };
            }
        }
        return { ...points[points.length - 1] };
    },

    referenceDeltaForEventProgress: (packCfg, startSoc, currentSoc, elapsedMs, status) => {
        const socDelta = Physics.referenceDeltaForSocWindow(packCfg, startSoc, currentSoc);
        if (socDelta.deltaWh > 0.05) {
            return { ...socDelta, method: 'soc-window' };
        }
        if (String(status).includes('CHARG') && elapsedMs > 0) {
            const refStart = Physics.interpolateReferencePoint(packCfg, startSoc);
            if (!refStart || !Number.isFinite(refStart.timeS)) return { ...socDelta, method: 'soc-window' };
            const refNow = Physics.interpolateReferencePointByTime(packCfg, refStart.timeS + (elapsedMs / 1000));
            if (!refNow) return { ...socDelta, method: 'soc-window' };
            return {
                deltaWh: Math.abs(refNow.cumWh - refStart.cumWh),
                deltaAh: Math.abs(refNow.cumAh - refStart.cumAh),
                start: refStart,
                end: refNow,
                method: 'time-fallback'
            };
        }
        return { ...socDelta, method: 'soc-window' };
    },

    calculateSoHByWindow: (history, packCfg, packSpecs, windowCfg) => {
        const cfg = windowCfg || {};
        const socLow = Number(cfg.socLow);
        const socHigh = Number(cfg.socHigh);
        const spanSoc = Math.abs(socHigh - socLow);
        const minSpanSoc = Number(cfg.minSpanSoc) || 15;

        if (isNaN(socLow) || isNaN(socHigh) || spanSoc < minSpanSoc) {
            return { soh: "--", measuredWh: null, referenceWh: null, method: "window-invalid" };
        }

        const segment = Physics.extractSocWindowHistory(history, socLow, socHigh);
        if (!segment || segment.length < 2) {
            return { soh: "--", measuredWh: null, referenceWh: null, method: "window-not-covered" };
        }

        const measuredWh = Physics.calculateTrapezoidalEnergy(segment);
        const referenceWh = Physics.referenceWhForSocWindow(packCfg, packSpecs, socLow, socHigh);
        if (!referenceWh || referenceWh <= 0) {
            return { soh: "--", measuredWh, referenceWh: null, method: "window-no-reference" };
        }

        const raw = (measuredWh / referenceWh) * 100;
        const soh = Math.min(100, Math.max(0, raw)).toFixed(1);
        return { soh, measuredWh, referenceWh, method: `window-${Math.min(socLow, socHigh)}-${Math.max(socLow, socHigh)}soc` };
    },
    formatTimeDisplay: (datePart, timePart) => {
        let dStr = datePart;

        if (timePart) {
            let pureTime = timePart;
            if (timePart.includes(' ')) pureTime = timePart.split(' ')[1];

            let pureDate = datePart;
            if (datePart.includes(' ')) pureDate = datePart.split(' ')[0];

            dStr = pureDate + " " + pureTime;
        }

        let d = new Date(dStr);

        if (isNaN(d.getTime())) return timePart || datePart;

        const mo = (d.getMonth() + 1).toString().padStart(2, '0');
        const da = d.getDate().toString().padStart(2, '0');
        const h = d.getHours().toString().padStart(2, '0');
        const m = d.getMinutes().toString().padStart(2, '0');

        return `${mo}/${da} ${h}:${m}`;
    },

    getTimestamp: (datePart, timePart) => {
        let dStr = datePart;
        if (timePart) {
            let pureTime = timePart.includes(' ') ? timePart.split(' ')[1] : timePart;
            let pureDate = datePart.includes(' ') ? datePart.split(' ')[0] : datePart;
            dStr = pureDate + " " + pureTime;
        }
        let d = new Date(dStr);
        return isNaN(d.getTime()) ? Date.now() : d.getTime();
    },

    calculateSoC: (vol, vMin, vMax) => {
        if (vol < 10) return 0;
        let soc = ((vol - vMin) / (vMax - vMin)) * 100;
        return Math.max(0, Math.min(100, soc));
    },

    // Bucket raw 5-second telemetry into N-minute intervals for cleaner SOC comparison.
    // Returns array sorted oldest→newest.
    aggregateToMinutes: (history, windowMin = 1) => {
        if (!history || history.length === 0) return [];
        const w = Math.max(1, Math.floor(windowMin));
        const buckets = new Map();
        history.forEach(entry => {
            const d = new Date(entry.timestamp);
            const totalMin = d.getHours() * 60 + d.getMinutes();
            const bucketMin = Math.floor(totalMin / w) * w;
            const h = Math.floor(bucketMin / 60);
            const m = bucketMin % 60;
            const key = `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} `
                      + `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(entry);
        });
        const result = [];
        for (const [key, entries] of buckets) {
            const avgVol = entries.reduce((s, e) => s + e.vol, 0) / entries.length;
            const avgAmp = entries.reduce((s, e) => s + e.amp, 0) / entries.length;
            const totalWh = Physics.calculateTrapezoidalEnergy(entries);
            const startSoc = entries[0].soc;
            const endSoc = entries[entries.length - 1].soc;
            const statusCounts = {};
            entries.forEach(e => { statusCounts[e.status] = (statusCounts[e.status] || 0) + 1; });
            const status = Object.entries(statusCounts).sort((a, b) => b[1] - a[1])[0][0];
            const detailedCounts = {};
            entries.forEach(e => { const ds = e.detailedStatus || e.status; detailedCounts[ds] = (detailedCounts[ds] || 0) + 1; });
            const detailedStatus = Object.entries(detailedCounts).sort((a, b) => b[1] - a[1])[0][0];
            result.push({ minute: key, avgVol, avgAmp, totalWh, startSoc, endSoc, status, detailedStatus, count: entries.length });
        }
        return result;
    }
};

const Analytics = {
    init: () => {
        const stored = localStorage.getItem('bss_cycle_history');
        if (stored) AppState.cycleHistory = JSON.parse(stored);
    },

    summarizeEvent: (slotId, event, packCfg, packSpecs, isActive = false) => {
        if (!event || !event.buffer || event.buffer.length < 2) return null;
        const startEntry = event.buffer[0];
        const endEntry = event.buffer[event.buffer.length - 1];
        const totalWh = Physics.calculateTrapezoidalEnergy(event.buffer);
        const totalAh = Physics.calculateTrapezoidalChargeAh(event.buffer);
        const windowSoH = Physics.calculateSoHByWindow(event.buffer, packCfg, packSpecs, SYSTEM_CONFIG.sohWindow);
        const referenceDelta = Physics.referenceDeltaForEventProgress(
            packCfg,
            startEntry.soc,
            endEntry.soc,
            endEntry.timestamp - startEntry.timestamp,
            event.status
        );
        const soh = windowSoH.soh !== "--"
            ? windowSoH.soh
            : (referenceDelta.deltaWh > 0 ? Math.min(100, Math.max(0, (totalWh / referenceDelta.deltaWh) * 100)).toFixed(1) : "--");
        return {
            id: `${slotId}-${event.status}-${startEntry.timestamp}`,
            slotId,
            type: event.status,
            startTime: startEntry.time,
            startTimestamp: startEntry.timestamp,
            endTime: endEntry.time,
            endTimestamp: endEntry.timestamp,
            durationMin: ((endEntry.timestamp - startEntry.timestamp) / 60000).toFixed(1),
            startSoc: startEntry.soc.toFixed(1),
            endSoc: endEntry.soc.toFixed(1),
            totalWh: totalWh.toFixed(2),
            totalAh: totalAh.toFixed(4),
            soh,
            sohMethod: windowSoH.soh !== "--" ? windowSoH.method : `reference-${referenceDelta.method || 'window'}-delta`,
            windowWh: windowSoH.measuredWh != null ? windowSoH.measuredWh.toFixed(2) : totalWh.toFixed(2),
            referenceWh: referenceDelta.deltaWh ? referenceDelta.deltaWh.toFixed(2) : "--",
            referenceAh: referenceDelta.deltaAh ? referenceDelta.deltaAh.toFixed(4) : "--",
            isActive,
            buffer: isActive ? event.buffer.map(item => ({ ...item })) : undefined
        };
    },

    analyzeSlotHistory: (slotId, history, packCfg, packSpecs) => {
        const cycles = [];
        const analysisRows = [];

        // Step 1: Build raw status segments
        const rawSegments = [];
        let current = null;
        history.forEach(entry => {
            const normalized = Physics.normalizeStatus(entry.status);
            entry.statusNormalized = normalized;
            if (!current || current.status !== normalized) {
                if (current) rawSegments.push(current);
                current = { status: normalized, buffer: [entry] };
            } else {
                current.buffer.push(entry);
            }
        });
        if (current) rawSegments.push(current);

        // Step 2: Merge same-type events separated by short IDLE gaps (< 5 minutes).
        // This prevents a single charging session with brief pauses from becoming dozens of tiny events.
        const GAP_MS = 5 * 60 * 1000;
        const merged = [];
        let si = 0;
        while (si < rawSegments.length) {
            const seg = rawSegments[si];
            const last = merged[merged.length - 1];
            if (
                seg.status === 'IDLE' &&
                last && last.status !== 'IDLE' &&
                si + 1 < rawSegments.length &&
                rawSegments[si + 1].status === last.status
            ) {
                const idleStart = seg.buffer[0].timestamp;
                const idleEnd = seg.buffer[seg.buffer.length - 1].timestamp;
                if (idleEnd - idleStart < GAP_MS) {
                    // Absorb this short idle gap + the following same-type segment into last
                    last.buffer.push(...seg.buffer);
                    last.buffer.push(...rawSegments[si + 1].buffer);
                    si += 2;
                    continue;
                }
            }
            merged.push({ status: seg.status, buffer: seg.buffer.slice() });
            si++;
        }

        // Step 3: Build analysisRows and cycles from merged segments
        let activeEvent = null;
        merged.forEach((seg, segIdx) => {
            const isLast = segIdx === merged.length - 1;
            const isActive = isLast && seg.status !== 'IDLE';

            if (seg.status === 'IDLE') {
                // Only include non-normal idle entries (sticky relay, etc.) in analysis
                // Skip REAL_IDLE rows — they are noise and slow down rendering
                seg.buffer.forEach(entry => {
                    const ds = entry.detailedStatus || 'REAL_IDLE';
                    if (ds === 'REAL_IDLE') return; // skip normal idle
                    analysisRows.push({
                        time: entry.time,
                        status: 'IDLE',
                        detailedStatus: ds,
                        realVoltage: entry.vol,
                        realCurrent: entry.amp,
                        realSoc: entry.soc,
                        realPower: entry.power,
                        realDeltaWh: 0,
                        realDeltaAh: 0,
                        refSoc: '--', refVoltage: '--', refCurrent: '--', refPower: '--',
                        refDeltaWh: '--', refDeltaAh: '--', soh: '--'
                    });
                });
                return;
            }

            // Build per-entry analysis rows using incremental (O(n)) energy accumulation
            const startEntry = seg.buffer[0];
            let cumWh = 0, cumAh = 0;
            seg.buffer.forEach((entry, entryIdx) => {
                if (entryIdx > 0) {
                    const prev = seg.buffer[entryIdx - 1];
                    const dt = (entry.timestamp - prev.timestamp) / 3600000;
                    if (dt > 0 && dt < 1) {
                        cumWh += ((prev.vol * Math.abs(prev.amp) + entry.vol * Math.abs(entry.amp)) / 2) * dt;
                        cumAh += ((Math.abs(prev.amp) + Math.abs(entry.amp)) / 2) * dt;
                    }
                }
                const refProgress = Physics.referenceDeltaForEventProgress(
                    packCfg,
                    startEntry.soc,
                    entry.soc,
                    entry.timestamp - startEntry.timestamp,
                    seg.status
                );
                const refNow = refProgress.end;
                const refDeltaWh = refProgress.deltaWh;
                const refDeltaAh = refProgress.deltaAh;
                const soh = refDeltaWh && refDeltaWh > 0 ? Math.min(100, Math.max(0, (cumWh / refDeltaWh) * 100)).toFixed(1) : '--';
                analysisRows.push({
                    time: entry.time,
                    status: seg.status,
                    detailedStatus: entry.detailedStatus || seg.status,
                    realVoltage: entry.vol,
                    realCurrent: entry.amp,
                    realSoc: entry.soc,
                    realPower: entry.power,
                    realDeltaWh: cumWh,
                    realDeltaAh: cumAh,
                    refSoc: refNow ? refNow.soc : '--',
                    refVoltage: refNow ? refNow.voltageV : '--',
                    refCurrent: refNow ? refNow.currentA : '--',
                    refPower: refNow ? refNow.powerW : '--',
                    refDeltaWh,
                    refDeltaAh,
                    soh
                });
            });

            const summary = Analytics.summarizeEvent(slotId, { status: seg.status, buffer: seg.buffer }, packCfg, packSpecs, isActive);
            if (summary) {
                if (isActive) activeEvent = summary;
                else cycles.push(summary);
            }
        });

        // Step 4: Filter out junk cycles that are noise / not real
        const validCycles = cycles.filter(c => {
            const dur = parseFloat(c.durationMin);
            const wh = parseFloat(c.totalWh);
            const socStart = parseFloat(c.startSoc);
            const socEnd = parseFloat(c.endSoc);
            const socDelta = Math.abs(socEnd - socStart);

            // Too short (< 1 min) with negligible energy
            if (dur < 1 && wh < 0.5) return false;

            // Charging but SoC didn't increase (or dropped) — fake charge
            if (c.type === 'CHARGING' && socEnd <= socStart && wh < 1) return false;

            // Discharging but SoC didn't decrease (or rose) — fake discharge
            if (c.type === 'DISCHARGING' && socEnd >= socStart && wh < 1) return false;

            // SoC stuck at 100% with negligible energy — battery already full, not a real cycle
            if (socStart >= 99.5 && socEnd >= 99.5 && wh < 5) return false;

            return true;
        });

        return {
            cycles: validCycles.reverse(),
            analysisRows: analysisRows.reverse(),
            activeEvent
        };
    }
};

const Charts = {
    update: (history) => {
        const ctx = document.getElementById('batChart').getContext('2d');
        const recent = history.slice(-300);

        if (AppState.chartInstance) {
            AppState.chartInstance.destroy();
        }

        AppState.chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: recent.map(d => d.time.split(' ')[1]),
                datasets: [
                    {
                        label: 'Voltage',
                        data: recent.map(d => d.vol),
                        borderColor: '#39c5cf',
                        backgroundColor: '#39c5cf',
                        yAxisID: 'y',
                        tension: 0.3,
                        pointRadius: 0
                    },
                    {
                        label: 'SoC',
                        data: recent.map(d => d.soc),
                        borderColor: '#a371f7',
                        backgroundColor: '#a371f7',
                        yAxisID: 'y_soc',
                        tension: 0.3,
                        pointRadius: 0
                    },
                    {
                        label: 'Current',
                        data: recent.map(d => d.amp),
                        borderColor: '#2ea043',
                        backgroundColor: '#2ea043',
                        yAxisID: 'y_curr',
                        borderDash: [5,5],
                        tension: 0.3,
                        pointRadius: 0
                    },
                    {
                        label: 'Power',
                        data: recent.map(d => d.power),
                        borderColor: '#ff9800',
                        backgroundColor: '#ff9800',
                        yAxisID: 'y_pow',
                        borderDash: [2,2],
                        tension: 0.3,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    y: {
                        type: 'linear', display: true, position: 'left',
                        title: { display: true, text: 'Voltage (V)', color: '#39c5cf' },
                        ticks: { color: '#39c5cf' }, grid: { color: '#2d333b' }
                    },
                    y_soc: {
                        type: 'linear', display: true, position: 'left', min: 0, max: 100,
                        title: { display: true, text: 'SoC (%)', color: '#a371f7' },
                        ticks: { color: '#a371f7' }, grid: { drawOnChartArea: false }
                    },
                    y_curr: {
                        type: 'linear', display: true, position: 'right',
                        title: { display: true, text: 'Current (A)', color: '#2ea043' },
                        ticks: { color: '#2ea043' }, grid: { drawOnChartArea: false }
                    },
                    y_pow: {
                        type: 'linear', display: true, position: 'right',
                        title: { display: true, text: 'Power (W)', color: '#ff9800' },
                        ticks: { color: '#ff9800' }, grid: { drawOnChartArea: false }
                    },
                    x: {
                        title: { display: true, text: 'Time', color: '#8b949e' },
                        grid: { color: '#2d333b' },
                        ticks: { color: '#8b949e' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#c9d1d9' },
                        onClick: (e, legendItem, legend) => {
                            const index = legendItem.datasetIndex;
                            const ci = legend.chart;

                            if (ci.isDatasetVisible(index)) {
                                ci.hide(index);
                                legendItem.hidden = true;
                            } else {
                                ci.show(index);
                                legendItem.hidden = false;
                            }

                            const axisID = ci.data.datasets[index].yAxisID;

                            if (ci.options.scales[axisID]) {
                                ci.options.scales[axisID].display = !legendItem.hidden;
                            }

                            ci.update();
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: 'rgba(22, 27, 34, 0.9)',
                        titleColor: '#e6edf3',
                        bodyColor: '#e6edf3',
                        borderColor: '#30363d',
                        borderWidth: 1
                    }
                }
            }
        });
    }
};

const UI = {
    renderSidebar: () => {
        const list = document.getElementById('unit-list');
        list.innerHTML = '';
        SYSTEM_CONFIG.slots.forEach(slot => {
            const item = document.createElement('div');
            item.className = 'nav-item ' + ((AppState.currentView === slot.id || AppState.currentView === ('reference:' + slot.id)) ? 'active' : '');
            item.onclick = () => { UI.switchView(slot.id); };
            const pack = SYSTEM_CONFIG.packs.find(p => p.id === slot.packId);
            item.innerHTML = `<span>${slot.name}</span><span class="nav-tag">${pack ? pack.mfgAh + 'Ah' : '?'}</span>`;
            list.appendChild(item);
        });
        const stItem = document.getElementById('nav-station');
        if (AppState.currentView === 'station') stItem.classList.add('active');
        else stItem.classList.remove('active');
    },

    switchView: (viewId) => {
        AppState.currentView = viewId;
        UI.renderSidebar();
        UI.renderDashboard();
    },

    renderDashboard: () => {
        if (AppState.currentView === 'station') {
            UI.renderStation();
            return;
        }
        if (typeof AppState.currentView === 'string' && AppState.currentView.startsWith('reference:')) {
            const slotId = Number(AppState.currentView.split(':')[1]);
            UI.renderReferenceDetail(slotId);
            return;
        }
        UI.renderSlot(AppState.currentView);
    },
    renderStation: () => {
        document.getElementById('view-station').style.display = 'block';
        document.getElementById('view-battery').style.display = 'none';
        document.getElementById('view-reference').style.display = 'none';
        document.getElementById('page-title').innerText = "Station Overview";

        let totWh = 0, totCap = 0, totLoad = 0, count = 0, socSum = 0;
        let stats = { CHARGING: 0, DISCHARGING: 0, IDLE: 0 };

        Object.values(AppState.processedData).forEach(d => {
            totWh += d.energy.available;
            totCap += d.energy.total;
            totLoad += (d.vol * d.amp);
            socSum += d.soc;
            count++;
            if (d.status.includes('CHARG')) stats.CHARGING++;
            else if (d.status.includes('DISCH')) stats.DISCHARGING++;
            else stats.IDLE++;
        });

        document.getElementById('st-wh').innerText = totWh.toFixed(0) + " Wh";
        document.getElementById('st-cap').innerText = "of " + totCap.toFixed(0) + " Wh Total Capacity";
        document.getElementById('st-bar').style.width = (totCap ? (totWh / totCap) * 100 : 0) + "%";

        document.getElementById('st-count').innerText = count;
        document.getElementById('st-soc').innerText = (count ? (socSum / count).toFixed(1) : 0) + "%";
        document.getElementById('st-watts').innerText = totLoad.toFixed(0) + " W";

        document.getElementById('st-dist').innerHTML =
            `CHG: ${stats.CHARGING} | DCH: ${stats.DISCHARGING} | IDLE: ${stats.IDLE}`;
        const refStatus = document.getElementById('ref-csv-status');
        if (refStatus) {
            refStatus.innerText = `${HARD_CODED_REFERENCE_PROFILE.label}\nEstimated Full Reference: ${HARD_CODED_REFERENCE_PROFILE.estimatedFullWh.toFixed(2)} Wh\nEstimated Full Charge: ${HARD_CODED_REFERENCE_PROFILE.estimatedFullAh.toFixed(4)} Ah`;
        }
    },

    runSoHSelfTest: () => {
        const resultEl = document.getElementById('soh-test-result');
        if (!SYSTEM_CONFIG.slots.length || !SYSTEM_CONFIG.packs.length || !SYSTEM_CONFIG.cells.length) {
            if (resultEl) resultEl.innerText = 'Missing slot/pack/cell config';
            return;
        }

        const slot = SYSTEM_CONFIG.slots[0];
        const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slot.packId) || SYSTEM_CONFIG.packs[0];
        const cellCfg = SYSTEM_CONFIG.cells.find(c => c.id === packCfg.cellId) || SYSTEM_CONFIG.cells[0];
        const specs = Physics.calculatePackSpecs(packCfg, cellCfg);

        const windowCfg = SYSTEM_CONFIG.sohWindow || { socLow: 10, socHigh: 50, minSpanSoc: 15 };
        const low = Number(windowCfg.socLow);
        const high = Number(windowCfg.socHigh);
        const span = Math.abs(high - low);
        if (!isFinite(low) || !isFinite(high) || span <= 0) {
            if (resultEl) resultEl.innerText = 'Invalid sohWindow config';
            return;
        }

        const measuredWhTarget = 800;
        const referenceWhTarget = 1000;
        const refFullWh = referenceWhTarget / (span / 100);

        const vNom = (specs.minV + specs.maxV) / 2;
        const amp = measuredWhTarget / vNom;
        const t0 = Date.now() - 3600000;
        const soc0 = Math.min(low, high);
        const soc1 = Math.max(low, high);
        const history = [];
        for (let i = 0; i <= 4; i++) {
            history.push({
                timestamp: t0 + i * 900000,
                vol: vNom,
                amp: amp,
                soc: soc0 + ((soc1 - soc0) * i) / 4,
                status: 'CHARGING'
            });
        }

        const testPack = { ...packCfg, referenceFullWh: refFullWh, referenceSocWhCurve: [] };
        const testSoH = Physics.calculateSoHByWindow(history, testPack, specs, windowCfg);

        const cycleRecord = {
            id: Date.now(),
            slotId: slot.id,
            type: 'CHARGING',
            startTime: Physics.formatTimeDisplay(new Date(t0).toISOString(), ''),
            durationMin: '60.0',
            startSoc: soc0.toFixed(1),
            endSoc: soc1.toFixed(1),
            totalWh: measuredWhTarget.toFixed(2),
            soh: testSoH.soh,
            sohMethod: testSoH.method,
            windowWh: testSoH.measuredWh != null ? testSoH.measuredWh.toFixed(2) : '--',
            referenceWh: testSoH.referenceWh != null ? testSoH.referenceWh.toFixed(2) : '--'
        };

        AppState.cycleHistory.unshift(cycleRecord);
        if (AppState.cycleHistory.length > 50) AppState.cycleHistory.pop();
        localStorage.setItem('bss_cycle_history', JSON.stringify(AppState.cycleHistory));

        if (resultEl) resultEl.innerText = 'Injected test cycle: SoH ' + testSoH.soh + '% (800/1000 window Wh)';
        UI.switchView(slot.id);
    },

    runCustomSoHTest: () => {
        const resultEl = document.getElementById('soh-test-result');
        const measuredWhTarget = Number(document.getElementById('test-measured-wh')?.value);
        const referenceWhTarget = Number(document.getElementById('test-reference-wh')?.value);
        const low = Number(document.getElementById('test-soc-low')?.value);
        const high = Number(document.getElementById('test-soc-high')?.value);

        if (!SYSTEM_CONFIG.slots.length || !SYSTEM_CONFIG.packs.length || !SYSTEM_CONFIG.cells.length) {
            if (resultEl) resultEl.innerText = 'Missing slot/pack/cell config';
            return;
        }
        if (!isFinite(measuredWhTarget) || measuredWhTarget <= 0 || !isFinite(referenceWhTarget) || referenceWhTarget <= 0) {
            if (resultEl) resultEl.innerText = 'Measured/Reference Wh must be > 0';
            return;
        }
        const span = Math.abs(high - low);
        if (!isFinite(low) || !isFinite(high) || span <= 0) {
            if (resultEl) resultEl.innerText = 'SoC window is invalid';
            return;
        }

        const slot = SYSTEM_CONFIG.slots[0];
        const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slot.packId) || SYSTEM_CONFIG.packs[0];
        const cellCfg = SYSTEM_CONFIG.cells.find(c => c.id === packCfg.cellId) || SYSTEM_CONFIG.cells[0];
        const specs = Physics.calculatePackSpecs(packCfg, cellCfg);
        const refFullWh = referenceWhTarget / (span / 100);

        const vNom = (specs.minV + specs.maxV) / 2;
        const amp = measuredWhTarget / vNom;
        const t0 = Date.now() - 3600000;
        const soc0 = Math.min(low, high);
        const soc1 = Math.max(low, high);
        const history = [];
        for (let i = 0; i <= 4; i++) {
            history.push({
                timestamp: t0 + i * 900000,
                vol: vNom,
                amp: amp,
                soc: soc0 + ((soc1 - soc0) * i) / 4,
                status: 'CHARGING'
            });
        }

        const testPack = { ...packCfg, referenceFullWh: refFullWh, referenceSocWhCurve: [] };
        const windowCfg = { ...SYSTEM_CONFIG.sohWindow, socLow: low, socHigh: high };
        const testSoH = Physics.calculateSoHByWindow(history, testPack, specs, windowCfg);

        const cycleRecord = {
            id: Date.now(),
            slotId: slot.id,
            type: 'CHARGING',
            startTime: Physics.formatTimeDisplay(new Date(t0).toISOString(), ''),
            durationMin: '60.0',
            startSoc: soc0.toFixed(1),
            endSoc: soc1.toFixed(1),
            totalWh: measuredWhTarget.toFixed(2),
            soh: testSoH.soh,
            sohMethod: testSoH.method,
            windowWh: testSoH.measuredWh != null ? testSoH.measuredWh.toFixed(2) : '--',
            referenceWh: testSoH.referenceWh != null ? testSoH.referenceWh.toFixed(2) : '--'
        };

        AppState.cycleHistory.unshift(cycleRecord);
        if (AppState.cycleHistory.length > 50) AppState.cycleHistory.pop();
        localStorage.setItem('bss_cycle_history', JSON.stringify(AppState.cycleHistory));
        if (resultEl) resultEl.innerText = 'Injected test cycle: SoH ' + testSoH.soh + '% (' + measuredWhTarget + '/' + referenceWhTarget + ' window Wh)';
        UI.switchView(slot.id);
    },

    refreshReferencePackSelect: () => {
        const selectEl = document.getElementById('ref-pack-select');
        if (!selectEl) return;
        const current = selectEl.value;
        selectEl.innerHTML = SYSTEM_CONFIG.packs
            .map(p => `<option value="${p.id}">${p.name}</option>`)
            .join('');
        if (current && SYSTEM_CONFIG.packs.some(p => p.id === current)) selectEl.value = current;
    },

    runReferenceCsvImport: () => {
        const fileInput = document.getElementById('ref-csv-file');
        const packSelect = document.getElementById('ref-pack-select');
        const statusEl = document.getElementById('ref-csv-status');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            if (statusEl) statusEl.innerText = 'Choose a CSV file first.';
            return;
        }
        const packId = packSelect && packSelect.value ? packSelect.value : SYSTEM_CONFIG.packs[0]?.id;
        if (!packId) {
            if (statusEl) statusEl.innerText = 'No pack found to attach reference data.';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => UI.importReferenceCsvText(String(reader.result || ''), packId);
        reader.onerror = () => { if (statusEl) statusEl.innerText = 'Failed to read CSV file.'; };
        reader.readAsText(fileInput.files[0]);
    },

    importReferenceCsvText: (text, packId) => {
        const statusEl = document.getElementById('ref-csv-status');
        const pack = SYSTEM_CONFIG.packs.find(p => p.id === packId);
        if (!pack) {
            if (statusEl) statusEl.innerText = 'Target pack not found.';
            return;
        }

        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const headerIdx = lines.findIndex(l => {
            const s = l.toLowerCase();
            return s.includes('time(s)') && s.includes('battery percentage') && s.includes('voltage(v)') && s.includes('current(a)');
        });
        if (headerIdx < 0) {
            if (statusEl) statusEl.innerText = 'CSV header not found. Need: Time(s), Battery Percentage, Voltage(V), Current(A).';
            return;
        }

        const parsed = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
            if (cols.length < 4) continue;
            const t = Number(cols[0]);
            const soc = Number((cols[1] || '').replace('%', ''));
            const v = Number(cols[2]);
            const a = Number(cols[3]);
            if (Number.isFinite(t) && Number.isFinite(soc) && Number.isFinite(v) && Number.isFinite(a)) {
                parsed.push({ t, soc, v, a });
            }
        }
        if (parsed.length < 10) {
            if (statusEl) statusEl.innerText = 'Not enough valid data rows in CSV.';
            return;
        }

        parsed.sort((x, y) => x.t - y.t);
        const rows = [];
        for (let i = 0; i < parsed.length; i++) {
            if (i === 0 || parsed[i].t > parsed[i - 1].t) rows.push(parsed[i]);
        }

        const first100 = rows.findIndex(r => r.soc >= 100);
        const usable = first100 >= 0 ? rows.slice(0, first100 + 1) : rows.slice();
        if (usable.length < 10) {
            if (statusEl) statusEl.innerText = 'Usable data too short after trimming.';
            return;
        }

        let socMax = -Infinity;
        let cumWh = 0;
        const series = [];
        for (let i = 0; i < usable.length; i++) {
            const r = usable[i];
            const socClamped = Math.max(0, Math.min(100, r.soc));
            socMax = Math.max(socMax, socClamped);
            if (i > 0) {
                const prev = usable[i - 1];
                const dtH = (r.t - prev.t) / 3600;
                if (dtH > 0) {
                    const p1 = prev.v * Math.abs(prev.a);
                    const p2 = r.v * Math.abs(r.a);
                    cumWh += ((p1 + p2) / 2) * dtH;
                }
            }
            series.push({ soc: socMax, wh: cumWh });
        }

        const lowSoc = series[0].soc;
        const highSoc = series[series.length - 1].soc;
        const interpWhAtSoc = (targetSoc) => {
            if (targetSoc <= series[0].soc) return series[0].wh;
            if (targetSoc >= series[series.length - 1].soc) return series[series.length - 1].wh;
            for (let i = 1; i < series.length; i++) {
                const a = series[i - 1];
                const b = series[i];
                if (targetSoc >= a.soc && targetSoc <= b.soc) {
                    if (b.soc === a.soc) return a.wh;
                    const r = (targetSoc - a.soc) / (b.soc - a.soc);
                    return a.wh + (b.wh - a.wh) * r;
                }
            }
            return series[series.length - 1].wh;
        };

        const step = 5;
        const curve = [];
        curve.push({ soc: Number(lowSoc.toFixed(2)), wh: Number(interpWhAtSoc(lowSoc).toFixed(2)) });
        for (let s = Math.ceil(lowSoc / step) * step; s <= Math.floor(highSoc / step) * step; s += step) {
            curve.push({ soc: Number(s.toFixed(2)), wh: Number(interpWhAtSoc(s).toFixed(2)) });
        }
        curve.push({ soc: Number(highSoc.toFixed(2)), wh: Number(interpWhAtSoc(highSoc).toFixed(2)) });

        const uniqueCurve = [];
        const seen = new Set();
        curve.forEach(p => {
            const key = p.soc.toFixed(2);
            if (!seen.has(key)) {
                seen.add(key);
                uniqueCurve.push(p);
            }
        });

        const spanSoc = highSoc - lowSoc;
        const spanWh = interpWhAtSoc(highSoc) - interpWhAtSoc(lowSoc);
        const estFullWh = spanSoc > 0 ? (spanWh / (spanSoc / 100)) : spanWh;

        pack.referenceSocWhCurve = uniqueCurve;
        pack.referenceFullWh = Number(estFullWh.toFixed(2));
        localStorage.setItem('bss_sys_config_v5', JSON.stringify(SYSTEM_CONFIG));

        const msg = [
            `Imported ${usable.length} rows for ${pack.name}.`,
            `SoC range used: ${lowSoc.toFixed(2)}% -> ${highSoc.toFixed(2)}%`,
            `Window energy: ${spanWh.toFixed(2)} Wh`,
            `Estimated full reference: ${pack.referenceFullWh.toFixed(2)} Wh`,
            `Curve points saved: ${uniqueCurve.length}`
        ].join('\n');

        const slotForPack = SYSTEM_CONFIG.slots.find(s => s.packId === packId);
        if (slotForPack) {
            const startTs = usable[0].t;
            const endTs = usable[usable.length - 1].t;
            const importRecord = {
                id: Date.now(),
                slotId: slotForPack.id,
                type: 'REFERENCE',
                startTime: new Date().toLocaleString(),
                durationMin: ((endTs - startTs) / 60).toFixed(1),
                startSoc: lowSoc.toFixed(1),
                endSoc: highSoc.toFixed(1),
                totalWh: spanWh.toFixed(2),
                soh: '100.0',
                sohMethod: 'reference-import-csv',
                windowWh: spanWh.toFixed(2),
                referenceWh: spanWh.toFixed(2)
            };
            AppState.cycleHistory.unshift(importRecord);
            if (AppState.cycleHistory.length > 50) AppState.cycleHistory.pop();
            localStorage.setItem('bss_cycle_history', JSON.stringify(AppState.cycleHistory));
        }

        if (statusEl) statusEl.innerText = msg;
        UI.renderSidebar();
        if (slotForPack) UI.switchView(slotForPack.id);
    },

    openReferenceDetail: (slotId) => {
        if (typeof slotId === 'string' && slotId.startsWith('reference:')) slotId = Number(slotId.split(':')[1]);
        const idNum = Number(slotId);
        if (!Number.isFinite(idNum)) return;
        AppState.currentView = `reference:${idNum}`;
        UI.renderSidebar();
        UI.renderDashboard();
    },

    backToBatteryFromReference: () => {
        if (typeof AppState.currentView === 'string' && AppState.currentView.startsWith('reference:')) {
            const slotId = Number(AppState.currentView.split(':')[1]);
            UI.switchView(slotId);
        } else {
            UI.switchView('station');
        }
    },

    updateReferenceMetricVisibility: (datasetIndex, shouldShow) => {
        if (!AppState.referenceChartInstance) return;
        const dataset = AppState.referenceChartInstance.data.datasets[datasetIndex];
        if (!dataset) return;
        AppState.referenceChartInstance.setDatasetVisibility(datasetIndex, shouldShow);
        const axisId = dataset.yAxisID;
        if (AppState.referenceChartInstance.options.scales[axisId]) {
            AppState.referenceChartInstance.options.scales[axisId].display = shouldShow;
        }
        AppState.referenceChartInstance.update();
        UI.renderReferenceLegend();
    },

    renderReferenceLegend: () => {
        const legendEl = document.getElementById('ref-legend');
        if (!legendEl || !AppState.referenceChartInstance) return;
        legendEl.innerHTML = '';
        AppState.referenceChartInstance.data.datasets.forEach((dataset, idx) => {
            const visible = AppState.referenceChartInstance.isDatasetVisible(idx);
            const label = document.createElement('label');
            label.style.display = 'inline-flex';
            label.style.alignItems = 'center';
            label.style.gap = '8px';
            label.style.cursor = 'pointer';
            label.style.opacity = visible ? '1' : '0.45';
            label.style.userSelect = 'none';
            label.innerHTML = `
                <input type="checkbox" ${visible ? 'checked' : ''} style="accent-color:${dataset.borderColor}; cursor:pointer;">
                <span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:${dataset.borderColor};"></span>
                <span>${dataset.label}</span>
            `;
            const input = label.querySelector('input');
            label.onclick = (e) => {
                e.preventDefault();
                UI.updateReferenceMetricVisibility(idx, !visible);
            };
            input.onclick = (e) => e.preventDefault();
            legendEl.appendChild(label);
        });
    },

    renderReferenceDetail: (slotId) => {
        const slotConfig = SYSTEM_CONFIG.slots.find(s => s.id === slotId);
        if (!slotConfig) { UI.switchView('station'); return; }
        const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slotConfig.packId);
        if (!packCfg) { UI.switchView('station'); return; }

        document.getElementById('view-station').style.display = 'none';
        document.getElementById('view-battery').style.display = 'none';
        document.getElementById('view-reference').style.display = 'block';
        document.getElementById('page-title').innerText = slotConfig.name + ' Reference Detail';

        const telemetry = Array.isArray(packCfg.referenceTelemetry) ? [...packCfg.referenceTelemetry] : [];
        const curve = Array.isArray(packCfg.referenceSocWhCurve) ? [...packCfg.referenceSocWhCurve] : [];
        const tbody = document.getElementById('ref-table-body');
        const summaryEl = document.getElementById('ref-summary');
        tbody.innerHTML = '';

        if (!telemetry.length) {
            if (summaryEl) summaryEl.innerText = 'No reference curve found. Import a reference CSV first.';
            if (AppState.referenceChartInstance) { AppState.referenceChartInstance.destroy(); AppState.referenceChartInstance = null; }
            return;
        }

        const points = telemetry
            .map(p => ({
                timeS: Number(p.timeS),
                soc: Number(p.soc),
                voltageV: Number(p.voltageV),
                currentA: Number(p.currentA),
                powerW: Number(p.powerW),
                cumWh: Number(p.cumWh)
            }))
            .filter(p => Number.isFinite(p.timeS) && Number.isFinite(p.soc) && Number.isFinite(p.voltageV) && Number.isFinite(p.currentA) && Number.isFinite(p.powerW))
            .sort((a, b) => a.timeS - b.timeS);

        points.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${p.timeS.toFixed(0)} s</td><td>${p.soc.toFixed(2)}</td><td>${p.voltageV.toFixed(2)}</td><td>${p.currentA.toFixed(2)}</td><td>${p.powerW.toFixed(2)}</td>`;
            tbody.appendChild(tr);
        });

        const lowSoc = points[0].soc;
        const highSoc = points[points.length - 1].soc;
        const spanWh = points[points.length - 1].cumWh - points[0].cumWh;
        const fullWh = Number(packCfg.referenceFullWh || 0);
        if (summaryEl) {
            summaryEl.innerText = `Pack: ${packCfg.name} | Charging reference | Time Range: ${points[0].timeS.toFixed(0)}s -> ${points[points.length - 1].timeS.toFixed(0)}s | SoC Range: ${lowSoc.toFixed(2)}% -> ${highSoc.toFixed(2)}% | Window Wh: ${spanWh.toFixed(2)} | Reference Full Wh: ${fullWh.toFixed(2)} | Points: ${points.length}`;
        }

        // Highlight the known power anomaly region (30-40% SoC where power drops from 192W → 178W)
        const anomalyEl = document.getElementById('ref-anomaly-note');
        if (anomalyEl) {
            const p35 = points.find(p => p.soc >= 35 && p.soc <= 36);
            const p40 = points.find(p => p.soc >= 40 && p.soc <= 41);
            if (p35 && p40) {
                anomalyEl.innerHTML = `⚠ <strong>Power Anomaly at 30–40% SoC:</strong> Power drops from ${p35.powerW.toFixed(1)} W (at ${p35.soc.toFixed(1)}%) to ${p40.powerW.toFixed(1)} W (at ${p40.soc.toFixed(1)}%) — cause unconfirmed. Compare other batteries against this reference.`;
                anomalyEl.style.display = 'block';
            }
        }

        const ctx = document.getElementById('refChart').getContext('2d');
        if (AppState.referenceChartInstance) AppState.referenceChartInstance.destroy();
        AppState.referenceChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: points.map(p => `${p.timeS.toFixed(0)} s`),
                datasets: [
                    {
                        label: 'Voltage',
                        data: points.map(p => p.voltageV),
                        borderColor: '#39c5cf',
                        backgroundColor: '#39c5cf',
                        yAxisID: 'y',
                        tension: 0.2
                    },
                    {
                        label: 'SoC',
                        data: points.map(p => p.soc),
                        borderColor: '#a371f7',
                        backgroundColor: '#a371f7',
                        yAxisID: 'y_soc',
                        tension: 0.2,
                        pointRadius: 0
                    },
                    {
                        label: 'Current',
                        data: points.map(p => p.currentA),
                        borderColor: '#2ea043',
                        backgroundColor: '#2ea043',
                        yAxisID: 'y_curr',
                        borderDash: [5, 5],
                        tension: 0.2
                    },
                    {
                        label: 'Power',
                        data: points.map(p => p.powerW),
                        borderColor: '#ff9800',
                        backgroundColor: '#ff9800',
                        yAxisID: 'y_pow',
                        borderDash: [2, 2],
                        tension: 0.2,
                        pointRadius: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { title: { display: true, text: 'Time' }, ticks: { color: '#8b949e', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: '#2d333b' } },
                    y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Voltage (V)', color: '#39c5cf' }, ticks: { color: '#39c5cf' }, grid: { color: '#2d333b' } },
                    y_soc: { type: 'linear', display: true, position: 'left', min: 0, max: 100, title: { display: true, text: 'SoC (%)', color: '#a371f7' }, ticks: { color: '#a371f7' }, grid: { drawOnChartArea: false } },
                    y_curr: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Current (A)', color: '#2ea043' }, ticks: { color: '#2ea043' }, grid: { drawOnChartArea: false } },
                    y_pow: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Power (W)', color: '#ff9800' }, ticks: { color: '#ff9800' }, grid: { drawOnChartArea: false } }
                },
                plugins: {
                    legend: {
                        display: false
                    }
                }
            }
        });
        UI.renderReferenceLegend();
    },
    showCycleDetail: (slotId, cycleId) => {
        if (!AppState.selectedCycleBySlot) AppState.selectedCycleBySlot = {};
        AppState.selectedCycleBySlot[slotId] = cycleId;
        const slotHistory = AppState.cycleHistory.filter(c => c.slotId === slotId);
        UI.renderCycleDetailPanel(slotId, slotHistory);
        UI.showCycleModal(slotId, cycleId);
    },

    showCycleModal: (slotId, cycleId) => {
        const cycle = AppState.cycleHistory.find(c => c.id === cycleId);
        if (!cycle) return;

        // Get the raw entries from history within the cycle's time window
        const slotData = AppState.processedData[slotId];
        const entries = (slotData?.history || []).filter(e =>
            e.timestamp >= (cycle.startTimestamp || 0) &&
            e.timestamp <= (cycle.endTimestamp || Infinity)
        );

        // Store full entries for range filtering
        AppState.cycleModalEntries = entries;
        AppState.cycleModalCycle = cycle;

        // Populate stats grid
        const typeColor = cycle.type === 'CHARGING' ? 'var(--accent-success)' : (cycle.type === 'DISCHARGING' ? 'var(--accent-danger)' : 'var(--accent-primary)');
        document.getElementById('cycle-modal-title').innerHTML =
            `<span style="color:${typeColor}">${cycle.type}</span> — Cycle Detail`;
        document.getElementById('cycle-modal-stats').innerHTML = `
            <div class="card" style="padding:10px;"><span class="metric-label">Duration</span><div style="font-size:1.1rem; font-weight:600;">${cycle.durationMin} min</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">SoC Range</span><div style="font-size:1.1rem; font-weight:600;">${cycle.startSoc}% → ${cycle.endSoc}%</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">Energy</span><div style="font-size:1.1rem; font-weight:600; color:var(--accent-warning);">${cycle.totalWh} Wh</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">SoH</span><div style="font-size:1.1rem; font-weight:600; color:var(--accent-primary);">${cycle.soh}%</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">Start Time</span><div style="font-size:0.9rem;">${cycle.startTime}</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">End Time</span><div style="font-size:0.9rem;">${cycle.endTime || '--'}</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">Window Wh</span><div style="font-size:0.9rem;">${cycle.windowWh || '--'}</div></div>
            <div class="card" style="padding:10px;"><span class="metric-label">Ref Wh</span><div style="font-size:0.9rem;">${cycle.referenceWh || '--'}</div></div>
        `;

        // Initialize range sliders
        const startSlider = document.getElementById('cycle-range-start');
        const endSlider = document.getElementById('cycle-range-end');
        if (startSlider && endSlider) {
            const maxIdx = Math.max(0, entries.length - 1);
            startSlider.min = 0; startSlider.max = maxIdx; startSlider.value = 0;
            endSlider.min = 0; endSlider.max = maxIdx; endSlider.value = maxIdx;
        }

        // Render chart + table + range labels for full range
        UI.renderCycleModalView(entries);
        document.getElementById('cycle-detail-modal').style.display = 'flex';
    },

    onCycleRangeChange: () => {
        const allEntries = AppState.cycleModalEntries;
        if (!allEntries || allEntries.length === 0) return;

        const startSlider = document.getElementById('cycle-range-start');
        const endSlider = document.getElementById('cycle-range-end');
        let startIdx = parseInt(startSlider.value);
        let endIdx = parseInt(endSlider.value);

        // Prevent crossover
        if (startIdx > endIdx) {
            startIdx = endIdx;
            startSlider.value = startIdx;
        }

        const sliced = allEntries.slice(startIdx, endIdx + 1);

        // Update range labels
        const startTime = sliced.length > 0 ? sliced[0].time : '--';
        const endTime = sliced.length > 0 ? sliced[sliced.length - 1].time : '--';
        const rangeLabel = document.getElementById('cycle-time-range-label');
        if (rangeLabel) rangeLabel.innerText = `${sliced.length} of ${allEntries.length} points`;
        const startLabel = document.getElementById('cycle-range-start-time');
        const endLabel = document.getElementById('cycle-range-end-time');
        if (startLabel) startLabel.innerText = startTime;
        if (endLabel) endLabel.innerText = endTime;

        UI.renderCycleModalView(sliced);
    },

    renderCycleModalView: (entries) => {
        // Update range labels
        const allEntries = AppState.cycleModalEntries || entries;
        const rangeLabel = document.getElementById('cycle-time-range-label');
        const startLabel = document.getElementById('cycle-range-start-time');
        const endLabel = document.getElementById('cycle-range-end-time');
        if (entries.length > 0) {
            if (rangeLabel) rangeLabel.innerText = `${entries.length} of ${allEntries.length} points`;
            if (startLabel) startLabel.innerText = entries[0].time;
            if (endLabel) endLabel.innerText = entries[entries.length - 1].time;
        }

        // Build chart
        const chartEl = document.getElementById('cycle-detail-chart');
        if (chartEl && entries.length > 1) {
            if (AppState.cycleChartInstance) { AppState.cycleChartInstance.destroy(); AppState.cycleChartInstance = null; }
            AppState.cycleChartInstance = new Chart(chartEl.getContext('2d'), {
                type: 'line',
                data: {
                    labels: entries.map(e => e.time.split(' ')[1] || e.time),
                    datasets: [
                        { label: 'Voltage', data: entries.map(e => e.vol), borderColor: '#39c5cf', yAxisID: 'y', tension: 0.3, pointRadius: 0 },
                        { label: 'SoC%', data: entries.map(e => e.soc), borderColor: '#a371f7', yAxisID: 'y_soc', tension: 0.3, pointRadius: 0 },
                        { label: 'Current', data: entries.map(e => e.amp), borderColor: '#2ea043', yAxisID: 'y_curr', borderDash: [4,3], tension: 0.3, pointRadius: 0 },
                        { label: 'Power', data: entries.map(e => e.power), borderColor: '#ff9800', yAxisID: 'y_pow', borderDash: [2,2], tension: 0.3, pointRadius: 0 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: { ticks: { color: '#8b949e', maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { color: '#2d333b' } },
                        y: { type: 'linear', position: 'left', title: { display: true, text: 'V', color: '#39c5cf' }, ticks: { color: '#39c5cf' }, grid: { color: '#2d333b' } },
                        y_soc: { type: 'linear', position: 'left', min: 0, max: 100, title: { display: true, text: '%', color: '#a371f7' }, ticks: { color: '#a371f7' }, grid: { drawOnChartArea: false } },
                        y_curr: { type: 'linear', position: 'right', title: { display: true, text: 'A', color: '#2ea043' }, ticks: { color: '#2ea043' }, grid: { drawOnChartArea: false } },
                        y_pow: { type: 'linear', position: 'right', title: { display: true, text: 'W', color: '#ff9800' }, ticks: { color: '#ff9800' }, grid: { drawOnChartArea: false } }
                    },
                    plugins: { legend: { labels: { color: '#c9d1d9', boxWidth: 12 } }, tooltip: { backgroundColor: 'rgba(22,27,34,0.9)', titleColor: '#e6edf3', bodyColor: '#e6edf3', borderColor: '#30363d', borderWidth: 1 } }
                }
            });
        } else if (chartEl) {
            if (AppState.cycleChartInstance) { AppState.cycleChartInstance.destroy(); AppState.cycleChartInstance = null; }
            chartEl.getContext('2d').clearRect(0, 0, chartEl.width, chartEl.height);
        }

        // Populate log table
        const tbody = document.getElementById('cycle-modal-table-body');
        tbody.innerHTML = '';
        entries.forEach(e => {
            const tr = document.createElement('tr');
            const bi = Physics.statusBadgeInfo(e.detailedStatus || e.status);
            tr.innerHTML = `
                <td style="font-family:'JetBrains Mono'; font-size:0.78rem;">${e.time}</td>
                <td style="color:var(--accent-primary)">${e.vol.toFixed(2)}</td>
                <td style="color:var(--accent-success)">${e.amp.toFixed(3)}</td>
                <td style="color:var(--accent-purple)">${e.soc.toFixed(1)}%</td>
                <td style="color:var(--accent-warning)">${e.power.toFixed(1)}</td>
                <td><span class="status-badge ${bi.cls}">${bi.label}</span></td>
            `;
            tbody.appendChild(tr);
        });
        document.getElementById('cycle-modal-entry-count').innerText = `${entries.length} data points`;
    },

    closeCycleModal: () => {
        document.getElementById('cycle-detail-modal').style.display = 'none';
        if (AppState.cycleChartInstance) { AppState.cycleChartInstance.destroy(); AppState.cycleChartInstance = null; }
        AppState.cycleModalEntries = null;
        AppState.cycleModalCycle = null;
    },

    applyCycleDurationFilter: () => {
        const slotId = AppState.currentView;
        if (!slotId || slotId === 'station') return;
        if (AppState.cycleHistoryPage) AppState.cycleHistoryPage[slotId] = 1;
        const slotHistory = AppState.cycleHistory.filter(c => c.slotId === slotId);
        UI.renderCycleHistoryTable(slotId, slotHistory);
    },

    resetCycleDurationFilter: () => {
        const minEl = document.getElementById('cycle-dur-min');
        const maxEl = document.getElementById('cycle-dur-max');
        if (minEl) minEl.value = '0';
        if (maxEl) maxEl.value = '';
        UI.applyCycleDurationFilter();
    },

    renderCycleHistoryTable: (slotId, slotHistory) => {
        const CYCLE_PAGE_SIZE = 20;
        if (!AppState.cycleHistoryPage) AppState.cycleHistoryPage = {};
        if (!AppState.cycleHistoryPage[slotId]) AppState.cycleHistoryPage[slotId] = 1;

        const histBody = document.getElementById('history-table-body');
        const histCount = document.getElementById('history-cycle-count');
        const histPager = document.getElementById('history-pager');
        if (!histBody) return;

        histBody.innerHTML = '';
        if (!slotHistory || slotHistory.length === 0) {
            histBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#666;">No completed cycles recorded yet.</td></tr>';
            if (histCount) histCount.innerText = '';
            if (histPager) histPager.style.display = 'none';
            UI.renderCycleDetailPanel(slotId, []);
            return;
        }

        // Apply duration filter
        const durMinEl = document.getElementById('cycle-dur-min');
        const durMaxEl = document.getElementById('cycle-dur-max');
        const durMin = durMinEl ? parseFloat(durMinEl.value) || 0 : 0;
        const durMax = durMaxEl && durMaxEl.value !== '' ? parseFloat(durMaxEl.value) : Infinity;
        const filtered = slotHistory.filter(c => {
            const dur = parseFloat(c.durationMin);
            return dur >= durMin && dur <= durMax;
        });

        if (filtered.length === 0) {
            histBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#666;">No cycles match duration filter.</td></tr>';
            if (histCount) histCount.innerText = `0 of ${slotHistory.length} events (filtered)`;
            if (histPager) histPager.style.display = 'none';
            return;
        }

        if (!AppState.selectedCycleBySlot) AppState.selectedCycleBySlot = {};
        if (!AppState.selectedCycleBySlot[slotId]) AppState.selectedCycleBySlot[slotId] = filtered[0].id;

        const totalPages = Math.ceil(filtered.length / CYCLE_PAGE_SIZE) || 1;
        AppState.cycleHistoryPage[slotId] = Math.max(1, Math.min(AppState.cycleHistoryPage[slotId], totalPages));
        const page = AppState.cycleHistoryPage[slotId];
        const start = (page - 1) * CYCLE_PAGE_SIZE;
        const pageItems = filtered.slice(start, start + CYCLE_PAGE_SIZE);

        pageItems.forEach(c => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            if (AppState.selectedCycleBySlot[slotId] === c.id) tr.style.background = 'rgba(88,166,255,0.12)';
            tr.onclick = () => UI.showCycleDetail(slotId, c.id);
            tr.innerHTML = `
                <td class="${c.type==='CHARGING'?'text-success':(c.type==='REFERENCE'?'text-primary':'text-danger')}">${c.type}</td>
                <td>${c.startTime}</td>
                <td>${c.durationMin} min</td>
                <td>${c.startSoc}% → ${c.endSoc}%</td>
                <td>${c.totalWh}</td>
                <td title="Method: ${c.sohMethod||'legacy'} | WindowWh: ${c.windowWh||'--'} | RefWh: ${c.referenceWh||'--'}">${c.soh}%</td>
            `;
            histBody.appendChild(tr);
        });

        if (histCount) histCount.innerText = filtered.length < slotHistory.length
            ? `${filtered.length} of ${slotHistory.length} events (filtered) — Page ${page}/${totalPages}`
            : `${slotHistory.length} events — Page ${page}/${totalPages}`;
        if (histPager) {
            histPager.style.display = 'flex';
            const prevBtn = document.getElementById('history-prev');
            const nextBtn = document.getElementById('history-next');
            if (prevBtn) prevBtn.disabled = page <= 1;
            if (nextBtn) nextBtn.disabled = page >= totalPages;
        }
        UI.renderCycleDetailPanel(slotId, slotHistory);
    },

    changeCycleHistoryPage: (slotId, delta) => {
        if (!AppState.cycleHistoryPage) AppState.cycleHistoryPage = {};
        AppState.cycleHistoryPage[slotId] = (AppState.cycleHistoryPage[slotId] || 1) + delta;
        const slotHistory = AppState.cycleHistory.filter(c => c.slotId === slotId);
        UI.renderCycleHistoryTable(slotId, slotHistory);
    },

    renderCycleDetailPanel: (slotId, slotHistory) => {
        const panel = document.getElementById('cycle-detail-panel');
        if (!panel) return;
        if (!slotHistory || !slotHistory.length) {
            panel.innerText = 'No cycle details available.';
            return;
        }

        const selectedId = AppState.selectedCycleBySlot ? AppState.selectedCycleBySlot[slotId] : null;
        const selected = slotHistory.find(c => c.id === selectedId) || slotHistory[0];

        const method = selected.sohMethod || 'legacy';
        const windowWh = selected.windowWh || '--';
        const referenceWh = selected.referenceWh || '--';
        const referenceAh = selected.referenceAh || '--';
        const isReference = selected.type === 'REFERENCE';

        panel.innerHTML = `
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                <div><strong>Type</strong><br>${selected.type}</div>
                <div><strong>SoH</strong><br>${selected.soh}%</div>
                <div><strong>Duration</strong><br>${selected.durationMin} min</div>
                <div><strong>Energy</strong><br>${selected.totalWh} Wh</div>
                <div><strong>Charge</strong><br>${selected.totalAh || '--'} Ah</div>
                <div><strong>End</strong><br>${selected.endTime || '--'}</div>
                <div><strong>SoC</strong><br>${selected.startSoc}% -> ${selected.endSoc}%</div>
                <div><strong>Method</strong><br>${method}</div>
                <div><strong>Window Wh</strong><br>${windowWh}</div>
                <div><strong>Ref Wh</strong><br>${referenceWh}</div>
                <div><strong>Ref Ah</strong><br>${referenceAh}</div>
            </div>
            <div style="margin-top:10px;"><strong>Start</strong><br>${selected.startTime}</div>
            ${isReference ? `<div style="margin-top:12px;"><button class="btn btn-secondary" onclick="UI.openReferenceDetail(${slotId})">Open Reference Detail</button></div>` : ''}
        `;
    },
    renderSlot: (id) => {
        const d = AppState.processedData[id];
        if (!d) return;

        const slotConfig = SYSTEM_CONFIG.slots.find(s => s.id === id);
        const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slotConfig.packId);
        const cellCfg = SYSTEM_CONFIG.cells.find(c => c.id === packCfg.cellId);

        const specs = Physics.calculatePackSpecs(packCfg, cellCfg);

        document.getElementById('view-station').style.display = 'none';
        document.getElementById('view-battery').style.display = 'block';
        document.getElementById('view-reference').style.display = 'none';
        document.getElementById('page-title').innerText = slotConfig.name + " Detail";

        document.getElementById('cfg-cell-type').innerText = cellCfg.name;
        document.getElementById('cfg-s').innerText = specs.series;
        document.getElementById('cfg-p').innerText = specs.parallel;
        document.getElementById('cfg-total-ah').innerText = packCfg.mfgAh + " Ah";

        const bar = document.getElementById('main-status-bar');
        const txt = document.getElementById('main-status-text');
        const badge = document.getElementById('bat-status-badge');
        bar.className = "card full-width status-bar-card"; bar.style.background = ""; bar.style.borderColor = "transparent"; bar.style.color = "inherit";

        // Warning banners for idle sub-types
        const stickyWarning = document.getElementById('sticky-relay-warning');
        const fakeWarning = document.getElementById('fake-state-warning');
        const fakeWarningText = document.getElementById('fake-state-warning-text');
        if (stickyWarning) stickyWarning.style.display = 'none';
        if (fakeWarning) fakeWarning.style.display = 'none';

        if (d.vol > specs.maxV + 2) {
            bar.classList.add('state-danger'); txt.innerText = "CRITICAL OVERVOLTAGE";
            badge.innerText = "DANGER"; badge.className = "status-badge st-danger";
            if (!alertSent) { API.sendAlert(`[${d.time}] OVERVOLTAGE on ${slotConfig.name}: ${d.vol}V`); alertSent = true; }
        } else {
            if (d.vol < specs.maxV) alertSent = false;
            const ds = d.detailedStatus || d.status;

            if (ds === 'STICKY_RELAY_IDLE') {
                bar.classList.add('state-danger'); txt.innerText = "STICKY RELAY — DANGER";
                badge.className = "status-badge st-sticky-relay"; badge.innerText = "STUCK RELAY";
                if (stickyWarning) stickyWarning.style.display = 'flex';
            } else if (ds === 'CHARGING_IDLE') {
                bar.classList.add('state-idle'); txt.innerText = "CHARGING IDLE (FAKE)";
                badge.className = "status-badge st-charging-idle"; badge.innerText = "CHG IDLE";
                if (fakeWarning && fakeWarningText) {
                    fakeWarningText.innerHTML = '<strong>CHARGING IDLE:</strong> Status reports Charging but no SoC increase detected. Charger may be connected but not delivering power.';
                    fakeWarning.style.display = 'flex';
                }
            } else if (ds === 'DISCHARGING_IDLE') {
                bar.classList.add('state-idle'); txt.innerText = "DISCHARGING IDLE (FAKE)";
                badge.className = "status-badge st-discharging-idle"; badge.innerText = "DCH IDLE";
                if (fakeWarning && fakeWarningText) {
                    fakeWarningText.innerHTML = '<strong>DISCHARGING IDLE:</strong> Status reports Discharging but no SoC decrease detected. Load may be disconnected.';
                    fakeWarning.style.display = 'flex';
                }
            } else if (d.status.includes('CHARG')) {
                bar.classList.add('state-charging'); txt.innerText = " CHARGING";
                badge.className = "status-badge st-charge"; badge.innerText = d.status;
            } else if (d.status.includes('DISCH')) {
                bar.classList.add('state-discharging'); txt.innerText = " DISCHARGING";
                badge.className = "status-badge st-discharge"; badge.innerText = d.status;
            } else {
                bar.classList.add('state-idle'); txt.innerText = " IDLE / STANDBY";
                badge.className = "status-badge st-idle"; badge.innerText = 'IDLE';
            }
        }

        document.getElementById('bat-soc').innerText = d.soc.toFixed(1) + "%";
        document.getElementById('bat-soc-bar').style.width = d.soc + "%";
        document.getElementById('bat-vol').innerText = d.vol.toFixed(2) + " V";
        document.getElementById('bat-v-range').innerText = `Range: ${specs.minV.toFixed(1)}-${specs.maxV.toFixed(1)}V`;
        document.getElementById('bat-amp').innerText = d.amp.toFixed(2) + " A";
        document.getElementById('bat-energy-avail').innerText = d.energy.available.toFixed(1) + " Wh";
        document.getElementById('bat-energy-used').innerText = d.energy.discharged.toFixed(2) + " Wh";

        const slotHistory = AppState.cycleHistory.filter(c => c.slotId === id);
        const currentSoH = d.activeEvent?.soh && d.activeEvent.soh !== "--"
            ? d.activeEvent.soh + "%"
            : (slotHistory.length > 0 && slotHistory[0].soh !== "--" ? slotHistory[0].soh + "%" : "--%");
        document.getElementById('bat-soh').innerText = currentSoH;

        if (!AppState.cycleHistoryPage) AppState.cycleHistoryPage = {};
        if (!AppState.cycleHistoryPage[id]) AppState.cycleHistoryPage[id] = 1;
        UI.renderCycleHistoryTable(id, slotHistory);
        Charts.update(d.history);
        AppState.activeLogData = [...(d.analysisRows || [])];
        UI.applyLogFilter(false);
        UI.renderMinuteTable(id);
    },

    // Table Logic
    applyLogFilter: (resetPage = true) => {
        const filter = document.getElementById('logFilter').value;
        if (filter === "ALL") AppState.filteredLogData = [...AppState.activeLogData];
        else AppState.filteredLogData = AppState.activeLogData.filter(d => String(d.status).includes(filter));
        if (resetPage) AppState.currentPage = 1;
        else {
            const maxPage = Math.ceil(AppState.filteredLogData.length / ROWS_PER_PAGE) || 1;
            if (AppState.currentPage > maxPage) AppState.currentPage = maxPage;
        }
        UI.calculateTableStats(AppState.filteredLogData);
        UI.renderTable();
    },

    calculateTableStats: (data) => {
        if (data.length === 0) {
            document.getElementById('stat-v-avg').innerText = "--";
            document.getElementById('stat-i-avg').innerText = "--";
            document.getElementById('stat-count').innerText = "0";
            return;
        }
        const latest = data[0];
        document.getElementById('stat-v-avg').innerText = `${(latest.realDeltaWh || 0).toFixed(2)} Wh`;
        document.getElementById('stat-i-avg').innerText = `${latest.refDeltaWh != null && latest.refDeltaWh !== '--' ? Number(latest.refDeltaWh).toFixed(2) : '--'} Wh`;
        document.getElementById('stat-count').innerText = `${latest.soh || '--'}%`;
    },

    changePage: (delta) => {
        const maxPage = Math.ceil(AppState.filteredLogData.length / ROWS_PER_PAGE) || 1;
        const newPage = AppState.currentPage + delta;
        if (newPage >= 1 && newPage <= maxPage) { AppState.currentPage = newPage; UI.renderTable(); }
    },

    renderTable: () => {
        const tbody = document.getElementById('log-table-body');
        tbody.innerHTML = '';
        const start = (AppState.currentPage - 1) * ROWS_PER_PAGE;
        const end = start + ROWS_PER_PAGE;
        AppState.filteredLogData.slice(start, end).forEach(d => {
            const tr = document.createElement('tr');
            const bi = Physics.statusBadgeInfo(d.detailedStatus || d.status);
            tr.innerHTML = `
                <td>${d.time}</td>
                <td style="color:var(--accent-primary)">${Number(d.realVoltage).toFixed(2)}</td>
                <td style="color:var(--accent-success)">${Number(d.realCurrent).toFixed(2)}</td>
                <td style="color:var(--accent-purple)">${Number(d.realSoc).toFixed(1)}%</td>
                <td style="color:var(--accent-warning)">${Number(d.realPower).toFixed(2)}</td>
                <td style="text-align:center;"><span class="status-badge ${bi.cls}">${bi.label}</span></td>
                <td>${Number(d.realDeltaWh || 0).toFixed(2)}</td>
                <td>${d.refSoc === '--' ? '--' : Number(d.refSoc).toFixed(1) + '%'}</td>
                <td>${d.refVoltage === '--' ? '--' : Number(d.refVoltage).toFixed(2)}</td>
                <td>${d.refCurrent === '--' ? '--' : Number(d.refCurrent).toFixed(2)}</td>
                <td>${d.refPower === '--' ? '--' : Number(d.refPower).toFixed(2)}</td>
                <td>${d.refDeltaWh === '--' || d.refDeltaWh == null ? '--' : Number(d.refDeltaWh).toFixed(2)}</td>
                <td>${d.soh === '--' ? '--' : d.soh + '%'}</td>
            `;
            tbody.appendChild(tr);
        });
        document.getElementById('page-indicator').innerText = `Page ${AppState.currentPage} of ${Math.ceil(AppState.filteredLogData.length / ROWS_PER_PAGE) || 1}`;
    },

    openSettings: () => {
        document.getElementById('settings-modal').style.display = 'flex';
        document.getElementById('cfg-url').value = SYSTEM_CONFIG.url;
        UI.showSettingsTab('tab-slots'); // Default
        UI.renderConfigLists();
    },
    closeSettings: () => { document.getElementById('settings-modal').style.display = 'none'; },
    showSettingsTab: (id) => {
        ['tab-cells','tab-packs','tab-slots'].forEach(t=>document.getElementById(t).style.display='none');
        document.getElementById(id).style.display='block';
    },

    renderConfigLists: () => {

        document.getElementById('cell-list').innerHTML = SYSTEM_CONFIG.cells.map(c =>
            `<div class="flex-row" style="margin-bottom:5px;">
                <input value="${c.name}" onchange="UI.updateCfg('cells','${c.id}','name',this.value)" placeholder="Name">
                <input type="number" value="${c.vMin}" onchange="UI.updateCfg('cells','${c.id}','vMin',this.value)" title="Min V">
                <input type="number" value="${c.vMax}" onchange="UI.updateCfg('cells','${c.id}','vMax',this.value)" title="Max V">
                <input type="number" value="${c.ah}" onchange="UI.updateCfg('cells','${c.id}','ah',this.value)" title="Ah">
                <button class="btn-secondary" style="color:var(--accent-red); border-color:var(--accent-red);" onclick="UI.removeCfg('cells','${c.id}')">&times;</button>
            </div>`
        ).join('');


        document.getElementById('pack-list').innerHTML = SYSTEM_CONFIG.packs.map(p => {
            const cellCfg = SYSTEM_CONFIG.cells.find(c => c.id === p.cellId) || SYSTEM_CONFIG.cells[0];
            const REF_SERIES = 17;
            const calcVMin    = cellCfg ? (cellCfg.vMin * p.series).toFixed(1) : '—';
            const calcVMax    = cellCfg ? (cellCfg.vMax * p.series).toFixed(1) : '—';
            const calcIdealWh = cellCfg ? (p.mfgAh * cellCfg.vMax * p.series).toFixed(1) : '—';
            const calcRefWh   = (HARD_CODED_REFERENCE_PROFILE.estimatedFullWh * (p.series / REF_SERIES)).toFixed(2);
            const calcRefAh   = (HARD_CODED_REFERENCE_PROFILE.estimatedFullAh * (p.series / REF_SERIES)).toFixed(4);
            // Auto-sync the stored value so interpolation is always correct
            p.referenceFullWh = parseFloat(calcRefWh);
            p.referenceFullAh = parseFloat(calcRefAh);
            return `<div style="margin-bottom:10px; padding:8px; background:var(--bg-secondary,#161b22); border-radius:6px; border:1px solid #30363d;">
                <div class="flex-row" style="margin-bottom:6px; gap:6px; flex-wrap:wrap;">
                    <input value="${p.name}" onchange="UI.updateCfg('packs','${p.id}','name',this.value)" placeholder="Pack Name" style="flex:2; min-width:100px;">
                    <select onchange="UI.updateCfg('packs','${p.id}','cellId',this.value); UI.renderConfigLists();" style="flex:1.5; min-width:100px;">${SYSTEM_CONFIG.cells.map(c => `<option value="${c.id}" ${c.id === p.cellId ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
                    <label style="display:flex;flex-direction:column;font-size:11px;color:#8b949e;flex:1;min-width:70px;">Series
                        <input type="number" min="1" value="${p.series}" onchange="UI.updateCfg('packs','${p.id}','series',+this.value); UI.renderConfigLists();" style="width:100%;">
                    </label>
                    <label style="display:flex;flex-direction:column;font-size:11px;color:#8b949e;flex:1;min-width:70px;">Total Ah
                        <input type="number" min="1" value="${p.mfgAh}" onchange="UI.updateCfg('packs','${p.id}','mfgAh',+this.value); UI.renderConfigLists();" style="width:100%;">
                    </label>
                    <label style="display:flex;flex-direction:column;font-size:11px;color:#8b949e;flex:1;min-width:70px; opacity:0.45;" title="⚠️ This field is no longer used. Ref Full Wh is now auto-calculated from the Series count. Editing this has no effect.">
                        <span style="text-decoration:line-through;">Ref Full Wh</span>
                        <input type="number" value="${p._legacyRefWh || ''}" placeholder="(disabled)" disabled style="width:100%; cursor:not-allowed; background:#1c1c1c; color:#555; border-color:#333;">
                    </label>
                    <button class="btn-secondary" style="color:var(--accent-red); border-color:var(--accent-red); align-self:flex-end;" onclick="UI.removeCfg('packs','${p.id}')">&times;</button>
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:12px; padding:6px 4px; background:#0d1117; border-radius:4px; border:1px solid #21262d;">
                    <span title="Calculated from cellVMin × Series">⚡ V range: <b style="color:#39c5cf;">${calcVMin} – ${calcVMax} V</b></span>
                    <span title="mfgAh × cellVMax × Series">🔋 Ideal: <b style="color:#39c5cf;">${calcIdealWh} Wh</b></span>
                    <span title="Auto-scaled from 17S reference (936.38 Wh × series/17)">📐 Ref Full Wh <span style="font-size:10px; color:#555;">(auto × ${p.series}/${REF_SERIES})</span>: <b style="color:#f0a500;">${calcRefWh} Wh</b></span>
                    <span title="Auto-scaled from 17S reference (14.016 Ah × series/17)">📐 Ref Full Ah: <b style="color:#f0a500;">${calcRefAh} Ah</b></span>
                </div>
                <div style="font-size:11px; color:#b08030; margin-top:5px; padding:3px 6px; background:#2a1f00; border-radius:3px; border-left:3px solid #f0a500;">
                    ⚠️ "Ref Full Wh" manual input is disabled — value is now auto-calculated based on Series count relative to the 17S reference profile.
                </div>
            </div>`;
        }).join('');


        document.getElementById('slot-list').innerHTML = SYSTEM_CONFIG.slots.map(s =>
            `<div class="flex-row" style="margin-bottom:5px;">
                <input value="${s.name}" onchange="UI.updateCfg('slots',${s.id},'name',this.value)">
                <select onchange="UI.updateCfg('slots',${s.id},'packId',this.value)">${SYSTEM_CONFIG.packs.map(p => `<option value="${p.id}" ${p.id === s.packId ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
                <input type="number" value="${s.colVol}" onchange="UI.updateCfg('slots',${s.id},'colVol',this.value)" title="V Col">
                <input type="number" value="${s.colAmp}" onchange="UI.updateCfg('slots',${s.id},'colAmp',this.value)" title="A Col">
                <input type="number" value="${s.colStat}" onchange="UI.updateCfg('slots',${s.id},'colStat',this.value)" title="Stat Col">
                <input type="number" value="${s.colSoc}" onchange="UI.updateCfg('slots',${s.id},'colSoc',this.value)" title="SoC Col">
                <button class="btn-secondary" style="color:var(--accent-red); border-color:var(--accent-red);" onclick="UI.removeCfg('slots',${s.id})">&times;</button>
            </div>`
        ).join('');
    },
    updateCfg: (type, id, key, val) => {
        const item = SYSTEM_CONFIG[type].find(x => x.id == id);
        if (!item) return;
        item[key] = isNaN(val) ? val : parseFloat(val);
        // Auto-recalculate reference Wh/Ah whenever series count changes on a pack
        if (type === 'packs' && (key === 'series' || key === 'cellId')) {
            const REF_SERIES = 17;
            item.referenceFullWh = parseFloat((HARD_CODED_REFERENCE_PROFILE.estimatedFullWh * (item.series / REF_SERIES)).toFixed(2));
            item.referenceFullAh = parseFloat((HARD_CODED_REFERENCE_PROFILE.estimatedFullAh * (item.series / REF_SERIES)).toFixed(4));
        }
    },
    removeCfg: (type, id) => { SYSTEM_CONFIG[type] = SYSTEM_CONFIG[type].filter(x => x.id != id); UI.renderConfigLists(); },
    addCellType: () => { SYSTEM_CONFIG.cells.push({ id: 'c' + Date.now(), name: 'New Cell', vMin: 3.0, vMax: 4.2, ah: 2.5 }); UI.renderConfigLists(); },
    addPackConfig: () => { SYSTEM_CONFIG.packs.push({ id: 'p' + Date.now(), name: 'New Pack', cellId: SYSTEM_CONFIG.cells[0]?.id, series: 1, mfgAh: 10, referenceFullWh: null, referenceSocWhCurve: [] }); UI.renderConfigLists(); },
    addSlot: () => { SYSTEM_CONFIG.slots.push({ id: Date.now(), name: 'Slot X', packId: SYSTEM_CONFIG.packs[0]?.id, colVol: 0, colAmp: 0, colStat: 0, colSoc: 0 }); UI.renderConfigLists(); },

    setMinTableFilter: (filter) => {
        AppState.minTableFilter = filter;
        // Update button active states
        ['ALL','CHARGING','DISCHARGING','IDLE'].forEach(f => {
            const btn = document.getElementById('min-filter-' + f);
            if (btn) btn.style.opacity = (f === filter) ? '1' : '0.4';
        });
        // Re-render using last known slot id stored on the table
        const slotId = Number(document.getElementById('min-table-body')?.dataset?.slotId);
        if (slotId) UI.renderMinuteTable(slotId);
    },

    setMinTableWindow: (val) => {
        const n = Math.max(1, Math.min(120, parseInt(val) || 1));
        AppState.minTableWindow = n;
        const input = document.getElementById('min-window-input');
        if (input) input.value = n;
        const label = document.getElementById('min-table-label');
        if (label) label.textContent = `${n}-MIN AGGREGATED DATA`;
        const slotId = Number(document.getElementById('min-table-body')?.dataset?.slotId);
        if (slotId) UI.renderMinuteTable(slotId);
    },

    renderMinuteTable: (id) => {
        const d = AppState.processedData[id];
        const tbody = document.getElementById('min-table-body');
        const countEl = document.getElementById('min-table-count');
        if (!d || !tbody) return;
        tbody.dataset.slotId = id;
        const filter = AppState.minTableFilter || 'ALL';
        const window = AppState.minTableWindow || 1;
        const allRows = Physics.aggregateToMinutes(d.history, window);
        const filtered = filter === 'ALL' ? allRows : allRows.filter(r => r.status === filter);
        tbody.innerHTML = '';
        // Show latest 300 minutes (most recent first)
        const display = filtered.slice().reverse().slice(0, 300);
        display.forEach(r => {
            const tr = document.createElement('tr');
            const bi = Physics.statusBadgeInfo(r.detailedStatus || r.status);
            tr.innerHTML = `
                <td style="font-family:'JetBrains Mono'; font-size:0.8rem;">${r.minute}</td>
                <td style="color:var(--accent-primary)">${r.avgVol.toFixed(2)}</td>
                <td style="color:var(--accent-success)">${r.avgAmp.toFixed(3)}</td>
                <td style="color:var(--accent-warning)">${r.totalWh.toFixed(3)}</td>
                <td style="color:var(--accent-purple)">${r.startSoc.toFixed(1)}% → ${r.endSoc.toFixed(1)}%</td>
                <td><span class="status-badge ${bi.cls}">${bi.label}</span></td>
                <td style="color:#666; font-size:0.75rem">${r.count}</td>
            `;
            tbody.appendChild(tr);
        });
        if (countEl) countEl.innerText = `${filtered.length} min (${filter}) — latest ${Math.min(filtered.length, 300)} shown`;
    },

    saveSettings: () => {
        SYSTEM_CONFIG.url = document.getElementById('cfg-url').value.trim();
        localStorage.setItem('bss_sys_config_v5', JSON.stringify(SYSTEM_CONFIG));
        UI.closeSettings();
        UI.renderSidebar();
        API.fetchData(); // Hot Reload
    }
};


const API = {
    startDataLoop: () => {
        API.fetchData();
        if(AppState.updateInterval) clearInterval(AppState.updateInterval);
        AppState.updateInterval = setInterval(API.fetchData, 5000);
    },
    fetchData: async () => {
        const statusEl = document.getElementById('conn-status');
        statusEl.innerText = "SYNCING...";
        let url = SYSTEM_CONFIG.url;
        if (!url) return;
        if(url.includes('script.google.com') && !url.includes('mode=read')) url = url.split('?')[0] + '?mode=read';

        try {
            const res = await fetch(url);
            const txt = await res.text();
            API.processCSV(txt);
            statusEl.innerText = "CONNECTED"; statusEl.style.color = "var(--accent-success)";
        } catch(e) {
            console.error(e); statusEl.innerText = "ERROR"; statusEl.style.color = "var(--accent-danger)";
        }
    },
    sendControl: async (status) => {
        if (AppState.currentView === 'station' || (typeof AppState.currentView === 'string' && AppState.currentView.startsWith('reference:'))) return;
        const btnFeedback = document.getElementById('cmd-feedback'); btnFeedback.innerText = "Sending...";
        let url = SYSTEM_CONFIG.url.split('?')[0] + `?mode=set_control&bat=${AppState.currentView}&status=${status}`;
        try { await fetch(url, {mode:'no-cors'}); btnFeedback.innerText = "OK"; setTimeout(()=>btnFeedback.innerText="",2000); }
        catch(e) { btnFeedback.innerText = "Error"; }
    },
    loadLocalCSV: () => {
        // Lets the user load the full PRASIMAX CSV directly from disk, bypassing Google Sheets row limits
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.csv';
        inp.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const statusEl = document.getElementById('conn-status');
            statusEl.innerText = 'LOADING...';
            const reader = new FileReader();
            reader.onload = (ev) => {
                API.processCSV(ev.target.result);
                statusEl.innerText = `LOCAL: ${file.name}`;
                statusEl.style.color = 'var(--accent-warning)';
            };
            reader.onerror = () => { statusEl.innerText = 'FILE READ ERROR'; statusEl.style.color = 'var(--accent-danger)'; };
            reader.readAsText(file);
        };
        inp.click();
    },

    sendAlert: async (message) => {
        let url = SYSTEM_CONFIG.url.split('?')[0] + `?mode=alert&msg=${encodeURIComponent(message)}`;
        try { await fetch(url, {mode:'no-cors'}); } catch(e) {}
    },
    detectColumnIndex: (headerRow, fallbackIndex, keywordGroups) => {
        if (!Array.isArray(headerRow) || !headerRow.length) return fallbackIndex;
        const normalized = headerRow.map(h => String(h || '').replace(/^\uFEFF/, '').trim().toLowerCase());
        for (const group of keywordGroups) {
            const idx = normalized.findIndex(h => group.every(k => h.includes(k)));
            if (idx >= 0) return idx;
        }
        return fallbackIndex;
    },

    processCSV: (text) => {
        const lines = text.trim().split(/\r?\n/);
        const data = lines.map(line => line.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
        const cycleRecords = [];
        const headerRow = data[0] || [];

        SYSTEM_CONFIG.slots.forEach(slot => {
            const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slot.packId);
            const cellCfg = SYSTEM_CONFIG.cells.find(c => c.id === packCfg.cellId);

            const specs = Physics.calculatePackSpecs(packCfg, cellCfg);
            const colVol = API.detectColumnIndex(headerRow, slot.colVol, [['voltage1'], ['voltage'], ['volt']]);
            const colAmp = API.detectColumnIndex(headerRow, slot.colAmp, [['current1'], ['current'], ['amp']]);
            const colStat = API.detectColumnIndex(headerRow, slot.colStat, [['status'], ['state']]);
            const colSoc = API.detectColumnIndex(headerRow, slot.colSoc, [['bat', '%'], ['battery', 'percentage'], ['soc']]);

            const history = [];
            let latest = null;
            let nonZeroCurrentCount = 0;
            let badDataCount = 0;
            // Valid voltage range: must be within ±20% of pack limits to be considered real data
            const volMin = specs.minV * 0.80;
            const volMax = specs.maxV * 1.15;

            for(let i=1; i<data.length; i++) {
                const row = data[i];
                if(row.length < 3) continue;

                const dateStr = row[0];
                const timeStr = row[1];

                const vol = parseFloat(row[colVol]);
                const amp = parseFloat(row[colAmp]);

                // Skip bad data: missing, zero, negative, or out-of-range voltage readings
                if(!isFinite(vol) || !isFinite(amp) || vol <= 0 || vol < volMin || vol > volMax) {
                    badDataCount++;
                    continue;
                }

                const cleanTime = Physics.formatTimeDisplay(dateStr, timeStr);
                const ts = Physics.getTimestamp(dateStr, timeStr);

                if(!isFinite(ts)) { badDataCount++; continue; }

                // Estimate live SoC from the hardcoded reference voltage curve when available.
                const soc = Physics.estimateSocFromReferenceVoltage(packCfg, vol, specs);
                const power = vol * amp;
                const baseStatus = Physics.normalizeStatus((row[colStat] || "IDLE").toUpperCase());
                const prevSoc = history.length > 0 ? history[history.length - 1].soc : null;
                const detailedStatus = Physics.classifyState(baseStatus, amp, prevSoc, soc);
                const entry = {
                    time: cleanTime,
                    timestamp: ts,
                    vol,
                    amp,
                    power,
                    soc,
                    status: baseStatus,
                    detailedStatus
                };
                history.push(entry);
                latest = entry;
                if (Math.abs(amp) > 0.001) nonZeroCurrentCount++;
            }

            if(latest) {
                const energyAvailable = specs.idealWh * (latest.soc / 100);
                const dischargedWh = Physics.calculateTrapezoidalEnergy(history);
                const analysis = Analytics.analyzeSlotHistory(slot.id, history, packCfg, specs);
                cycleRecords.push(...analysis.cycles);

                const currentSoH = analysis.activeEvent?.soh && analysis.activeEvent.soh !== "--"
                    ? analysis.activeEvent.soh
                    : (analysis.cycles.length > 0 && analysis.cycles[0].soh !== "--" ? analysis.cycles[0].soh : "--");

                AppState.processedData[slot.id] = {
                    ...latest,
                    meta: { pack: packCfg, cell: cellCfg, parallel: specs.parallel, vRange: `${specs.minV.toFixed(1)}-${specs.maxV.toFixed(1)}V` },
                    energy: { available: energyAvailable, total: specs.idealWh, discharged: dischargedWh },
                    soh: currentSoH,
                    history,
                    analysisRows: analysis.analysisRows,
                    activeEvent: analysis.activeEvent,
                    diagnostics: { colVol, colAmp, colStat, colSoc, nonZeroCurrentCount, badDataCount, totalRows: data.length - 1 }
                };
            }
        });
        AppState.cycleHistory = cycleRecords.sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0));
        localStorage.setItem('bss_cycle_history', JSON.stringify(AppState.cycleHistory));
        document.getElementById('last-sync').innerText = "SYNC: " + new Date().toLocaleTimeString();
        UI.renderDashboard();
    }
};


window.onload = () => {
    Analytics.init();
    const saved = localStorage.getItem('bss_sys_config_v5');
    if (saved) {
        const parsed = JSON.parse(saved);
        SYSTEM_CONFIG = {
            ...DEFAULT_CONFIG,
            ...parsed,
            sohWindow: { ...DEFAULT_CONFIG.sohWindow, ...(parsed.sohWindow || {}) }
        };
        SYSTEM_CONFIG.packs = (SYSTEM_CONFIG.packs || []).map(p => ({
            referenceFullWh: null,
            referenceSocWhCurve: [],
            referenceTelemetry: [],
            referenceLabel: HARD_CODED_REFERENCE_PROFILE.label,
            ...p
        }));
    }
    // Auto-migrate: if stored pack still has old 14S config (SWAP is 17S per reference CSV metadata)
    SYSTEM_CONFIG.packs.forEach(p => {
        if (p.series === 14) {
            p.series = 17;
            p.mfgAh = 85.0;
        }
    });

    const firstPack = SYSTEM_CONFIG.packs[0];
    if (firstPack) {
        firstPack.referenceTelemetry = HARD_CODED_REFERENCE_PROFILE.telemetry.map(p => ({ ...p }));
        firstPack.referenceSocWhCurve = HARD_CODED_REFERENCE_PROFILE.telemetry.map(p => ({ soc: p.soc, wh: p.cumWh }));
        firstPack.referenceFullWh = HARD_CODED_REFERENCE_PROFILE.estimatedFullWh;
        firstPack.referenceFullAh = HARD_CODED_REFERENCE_PROFILE.estimatedFullAh;
        firstPack.referenceLabel = HARD_CODED_REFERENCE_PROFILE.label;
    }
    UI.renderSidebar();
    if (SYSTEM_CONFIG.url) API.startDataLoop(); else UI.openSettings();
};



















