
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
        { id: 'p1', name: 'SWAP Bike Pack', cellId: 'c1', series: 14, mfgAh: 71.4, referenceFullWh: null, referenceSocWhCurve: [] }
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
    selectedCycleBySlot: {}
};
let alertSent = false;
const ROWS_PER_PAGE = 50;

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
    }
};

const Analytics = {
    init: () => {
        const stored = localStorage.getItem('bss_cycle_history');
        if (stored) AppState.cycleHistory = JSON.parse(stored);
    },

    processRealtime: (slotId, latestData, packCfg, packSpecs) => {
        if (!AppState.slotStates[slotId]) {
            AppState.slotStates[slotId] = {
                status: latestData.status,
                startTime: latestData.timestamp,
                startSoc: latestData.soc,
                buffer: []
            };
            return;
        }

        const prev = AppState.slotStates[slotId];

        if (prev.status !== latestData.status) {
            if (prev.status === 'CHARGING' || prev.status === 'DISCHARGING') {
                const totalEnergy = Physics.calculateTrapezoidalEnergy(prev.buffer);

                const windowSoH = Physics.calculateSoHByWindow(prev.buffer, packCfg, packSpecs, SYSTEM_CONFIG.sohWindow);
                const fallbackSoH = Physics.calculateSoH(totalEnergy, prev.startSoc, latestData.soc, packSpecs.idealWh);
                const soh = windowSoH.soh !== "--" ? windowSoH.soh : fallbackSoH;

                const startDateStr = new Date(prev.startTime).toISOString();
                const cleanStartTime = Physics.formatTimeDisplay(startDateStr, "");

                const cycleRecord = {
                    id: Date.now(),
                    slotId: slotId,
                    type: prev.status,
                    startTime: cleanStartTime,
                    durationMin: ((latestData.timestamp - prev.startTime) / 60000).toFixed(1),
                    startSoc: prev.startSoc.toFixed(1),
                    endSoc: latestData.soc.toFixed(1),
                    totalWh: totalEnergy.toFixed(2),
                    soh: soh,
                    sohMethod: windowSoH.soh !== "--" ? windowSoH.method : "delta-soc-fallback",
                    windowWh: windowSoH.measuredWh != null ? windowSoH.measuredWh.toFixed(2) : "--",
                    referenceWh: windowSoH.referenceWh != null ? windowSoH.referenceWh.toFixed(2) : "--"
                };

                AppState.cycleHistory.unshift(cycleRecord);
                if (AppState.cycleHistory.length > 50) AppState.cycleHistory.pop();
                localStorage.setItem('bss_cycle_history', JSON.stringify(AppState.cycleHistory));
            }

            AppState.slotStates[slotId] = { status: latestData.status, startTime: latestData.timestamp, startSoc: latestData.soc, buffer: [] };
        }

        if (latestData.status !== 'IDLE') {
            AppState.slotStates[slotId].buffer.push({
                timestamp: latestData.timestamp,
                vol: latestData.vol,
                amp: latestData.amp
            });
        }
    }
};

const Charts = {
    update: (history) => {
        const ctx = document.getElementById('batChart').getContext('2d');
        const recent = history.slice(-50);

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
                        tension: 0.3
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
                        tension: 0.3
                    },
                    {
                        label: 'Power',
                        data: recent.map(d => d.power),
                        borderColor: '#ff9800',
                        backgroundColor: '#ff9800',
                        yAxisID: 'y_pow',
                        borderDash: [2,2],
                        tension: 0.3,
                        pointRadius: 1
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
                    // Left Axes
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
                    // Right Axes
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
                                // If dataset is now hidden, hide axis. If visible, show axis.
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
        UI.refreshReferencePackSelect();
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

    renderReferenceDetail: (slotId) => {
        const slotConfig = SYSTEM_CONFIG.slots.find(s => s.id === slotId);
        if (!slotConfig) { UI.switchView('station'); return; }
        const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slotConfig.packId);
        if (!packCfg) { UI.switchView('station'); return; }

        document.getElementById('view-station').style.display = 'none';
        document.getElementById('view-battery').style.display = 'none';
        document.getElementById('view-reference').style.display = 'block';
        document.getElementById('page-title').innerText = slotConfig.name + ' Reference Detail';

        const curve = Array.isArray(packCfg.referenceSocWhCurve) ? [...packCfg.referenceSocWhCurve] : [];
        const tbody = document.getElementById('ref-table-body');
        const summaryEl = document.getElementById('ref-summary');
        tbody.innerHTML = '';

        if (!curve.length) {
            if (summaryEl) summaryEl.innerText = 'No reference curve found. Import a reference CSV first.';
            if (AppState.referenceChartInstance) { AppState.referenceChartInstance.destroy(); AppState.referenceChartInstance = null; }
            return;
        }

        const points = curve
            .map(p => ({ soc: Number(p.soc), wh: Number(p.wh) }))
            .filter(p => Number.isFinite(p.soc) && Number.isFinite(p.wh))
            .sort((a, b) => a.soc - b.soc);

        points.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${p.soc.toFixed(2)}</td><td>${p.wh.toFixed(2)}</td>`;
            tbody.appendChild(tr);
        });

        const lowSoc = points[0].soc;
        const highSoc = points[points.length - 1].soc;
        const spanWh = points[points.length - 1].wh - points[0].wh;
        const fullWh = Number(packCfg.referenceFullWh || 0);
        if (summaryEl) {
            summaryEl.innerText = `Pack: ${packCfg.name} | SoC Range: ${lowSoc.toFixed(2)}% -> ${highSoc.toFixed(2)}% | Window Wh: ${spanWh.toFixed(2)} | Reference Full Wh: ${fullWh.toFixed(2)} | Points: ${points.length}`;
        }

        const ctx = document.getElementById('refChart').getContext('2d');
        if (AppState.referenceChartInstance) AppState.referenceChartInstance.destroy();
        AppState.referenceChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: points.map(p => p.soc.toFixed(1)),
                datasets: [{
                    label: 'Reference Wh',
                    data: points.map(p => p.wh),
                    borderColor: '#58a6ff',
                    backgroundColor: '#58a6ff',
                    tension: 0.2,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { title: { display: true, text: 'SoC (%)' }, ticks: { color: '#8b949e' }, grid: { color: '#2d333b' } },
                    y: { title: { display: true, text: 'Cumulative Wh' }, ticks: { color: '#8b949e' }, grid: { color: '#2d333b' } }
                },
                plugins: { legend: { labels: { color: '#c9d1d9' } } }
            }
        });
    },
    showCycleDetail: (slotId, cycleId) => {
        if (!AppState.selectedCycleBySlot) AppState.selectedCycleBySlot = {};
        AppState.selectedCycleBySlot[slotId] = cycleId;
        const slotHistory = AppState.cycleHistory.filter(c => c.slotId === slotId);
        UI.renderCycleDetailPanel(slotId, slotHistory);
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
        const isReference = selected.type === 'REFERENCE';

        panel.innerHTML = `
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                <div><strong>Type</strong><br>${selected.type}</div>
                <div><strong>SoH</strong><br>${selected.soh}%</div>
                <div><strong>Duration</strong><br>${selected.durationMin} min</div>
                <div><strong>Energy</strong><br>${selected.totalWh} Wh</div>
                <div><strong>SoC</strong><br>${selected.startSoc}% -> ${selected.endSoc}%</div>
                <div><strong>Method</strong><br>${method}</div>
                <div><strong>Window Wh</strong><br>${windowWh}</div>
                <div><strong>Ref Wh</strong><br>${referenceWh}</div>
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

        if (d.vol > specs.maxV + 2) {
            bar.classList.add('state-danger'); txt.innerText = "CRITICAL OVERVOLTAGE";
            badge.innerText = "DANGER"; badge.className = "status-badge st-danger";
            if (!alertSent) { API.sendAlert(`[${d.time}] OVERVOLTAGE on ${slotConfig.name}: ${d.vol}V`); alertSent = true; }
        } else {
            if (d.vol < specs.maxV) alertSent = false;
            if (d.status.includes('CHARG')) {
                bar.classList.add('state-charging'); txt.innerText = " CHARGING";
                badge.className = "status-badge st-charge";
            } else if (d.status.includes('DISCH')) {
                bar.classList.add('state-discharging'); txt.innerText = " DISCHARGING";
                badge.className = "status-badge st-discharge";
            } else {
                bar.classList.add('state-idle'); txt.innerText = " IDLE / STANDBY";
                badge.className = "status-badge st-idle";
            }
            badge.innerText = d.status;
        }

        document.getElementById('bat-soc').innerText = d.soc.toFixed(1) + "%";
        document.getElementById('bat-soc-bar').style.width = d.soc + "%";
        document.getElementById('bat-vol').innerText = d.vol.toFixed(2) + " V";
        document.getElementById('bat-v-range').innerText = `Range: ${specs.minV.toFixed(1)}-${specs.maxV.toFixed(1)}V`;
        document.getElementById('bat-amp').innerText = d.amp.toFixed(2) + " A";
        document.getElementById('bat-energy-avail').innerText = d.energy.available.toFixed(1) + " Wh";
        document.getElementById('bat-energy-used').innerText = d.energy.discharged.toFixed(2) + " Wh";

        const slotHistory = AppState.cycleHistory.filter(c => c.slotId === id);
        const currentSoH = slotHistory.length > 0 && slotHistory[0].soh !== "--" ? slotHistory[0].soh + "%" : "--%";
        document.getElementById('bat-soh').innerText = currentSoH;

        const histBody = document.getElementById('history-table-body');
        histBody.innerHTML = '';
        if (slotHistory.length > 0) {
            if (!AppState.selectedCycleBySlot) AppState.selectedCycleBySlot = {};
            if (!AppState.selectedCycleBySlot[id]) AppState.selectedCycleBySlot[id] = slotHistory[0].id;

            slotHistory.slice(0, 5).forEach(c => {
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                if (AppState.selectedCycleBySlot[id] === c.id) tr.style.background = 'rgba(88,166,255,0.12)';
                tr.onclick = () => UI.showCycleDetail(id, c.id);
                tr.innerHTML = `
                    <td class="${c.type==='CHARGING'?'text-success':(c.type==='REFERENCE'?'text-primary':'text-danger')}">${c.type}</td>
                    <td>${c.startTime}</td>
                    <td>${c.durationMin} min</td>
                    <td>${c.startSoc}% -> ${c.endSoc}%</td>
                    <td>${c.totalWh}</td>
                    <td title="Method: ${c.sohMethod || "legacy"} | WindowWh: ${c.windowWh || "--"} | RefWh: ${c.referenceWh || "--"}">${c.soh}%</td>
                `;
                histBody.appendChild(tr);
            });
            UI.renderCycleDetailPanel(id, slotHistory);
        } else {
            histBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#666;">No completed cycles recorded yet.</td></tr>';
            UI.renderCycleDetailPanel(id, []);
        }
        Charts.update(d.history);
        AppState.activeLogData = [...d.history].reverse();
        UI.applyLogFilter();
    },

    // Table Logic
    applyLogFilter: () => {
        const filter = document.getElementById('logFilter').value;
        if (filter === "ALL") AppState.filteredLogData = [...AppState.activeLogData];
        else AppState.filteredLogData = AppState.activeLogData.filter(d => d.status.includes(filter));
        AppState.currentPage = 1;
        UI.calculateTableStats(AppState.filteredLogData);
        UI.renderTable();
    },

    calculateTableStats: (data) => {
        if(data.length === 0) {
            document.getElementById('stat-v-avg').innerText = "--";
            document.getElementById('stat-i-avg').innerText = "--";
            document.getElementById('stat-count').innerText = 0; return;
        }
        const vSum = data.reduce((a,b) => a + b.vol, 0);
        const iSum = data.reduce((a,b) => a + b.amp, 0);
        document.getElementById('stat-v-avg').innerText = (vSum/data.length).toFixed(2);
        document.getElementById('stat-i-avg').innerText = (iSum/data.length).toFixed(2);
        document.getElementById('stat-count').innerText = data.length;
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
            let badgeClass = 'st-idle';
            if (d.status.includes('CHARG')) badgeClass = 'st-charge';
            if (d.status.includes('DISCH')) badgeClass = 'st-discharge';
            if (d.vol > 75.0) badgeClass = 'st-danger';
            tr.innerHTML = `<td>${d.time}</td><td style="color:var(--accent-primary)">${d.vol.toFixed(2)}</td><td style="color:var(--accent-success)">${d.amp.toFixed(2)}</td><td style="color:var(--accent-purple)">${d.soc.toFixed(1)}%</td><td style="text-align:center;"><span class="status-badge ${badgeClass}">${d.status}</span></td>`;
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


        document.getElementById('pack-list').innerHTML = SYSTEM_CONFIG.packs.map(p =>
            `<div class="flex-row" style="margin-bottom:5px;">
                <input value="${p.name}" onchange="UI.updateCfg('packs','${p.id}','name',this.value)" placeholder="Pack Name">
                <select onchange="UI.updateCfg('packs','${p.id}','cellId',this.value)">${SYSTEM_CONFIG.cells.map(c => `<option value="${c.id}" ${c.id === p.cellId ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
                <input type="number" value="${p.series}" onchange="UI.updateCfg('packs','${p.id}','series',this.value)" placeholder="Series">
                <input type="number" value="${p.mfgAh}" onchange="UI.updateCfg('packs','${p.id}','mfgAh',this.value)" placeholder="Total Ah">
                <input type="number" value="${p.referenceFullWh || ""}" onchange="UI.updateCfg('packs','${p.id}','referenceFullWh',this.value)" placeholder="Ref Full Wh">
                <button class="btn-secondary" style="color:var(--accent-red); border-color:var(--accent-red);" onclick="UI.removeCfg('packs','${p.id}')">&times;</button>
            </div>`
        ).join('');


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
    updateCfg: (type, id, key, val) => { const item = SYSTEM_CONFIG[type].find(x => x.id == id); if (item) item[key] = isNaN(val) ? val : parseFloat(val); },
    removeCfg: (type, id) => { SYSTEM_CONFIG[type] = SYSTEM_CONFIG[type].filter(x => x.id != id); UI.renderConfigLists(); },
    addCellType: () => { SYSTEM_CONFIG.cells.push({ id: 'c' + Date.now(), name: 'New Cell', vMin: 3.0, vMax: 4.2, ah: 2.5 }); UI.renderConfigLists(); },
    addPackConfig: () => { SYSTEM_CONFIG.packs.push({ id: 'p' + Date.now(), name: 'New Pack', cellId: SYSTEM_CONFIG.cells[0]?.id, series: 1, mfgAh: 10, referenceFullWh: null, referenceSocWhCurve: [] }); UI.renderConfigLists(); },
    addSlot: () => { SYSTEM_CONFIG.slots.push({ id: Date.now(), name: 'Slot X', packId: SYSTEM_CONFIG.packs[0]?.id, colVol: 0, colAmp: 0, colStat: 0, colSoc: 0 }); UI.renderConfigLists(); },

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
    sendAlert: async (message) => {
        let url = SYSTEM_CONFIG.url.split('?')[0] + `?mode=alert&msg=${encodeURIComponent(message)}`;
        try { await fetch(url, {mode:'no-cors'}); } catch(e) {}
    },
    processCSV: (text) => {
        const lines = text.trim().split('\n');
        const data = lines.map(line => line.split(',').map(c => c.replace(/^"|"$/g, '').trim()));

        SYSTEM_CONFIG.slots.forEach(slot => {
            const packCfg = SYSTEM_CONFIG.packs.find(p => p.id === slot.packId);
            const cellCfg = SYSTEM_CONFIG.cells.find(c => c.id === packCfg.cellId);

            const specs = Physics.calculatePackSpecs(packCfg, cellCfg);

            const history = [];
            let latest = null;

            for(let i=1; i<data.length; i++) {
                const row = data[i];
                if(row.length < 6) continue;

                const dateStr = row[0];
                const timeStr = row[1];
                const cleanTime = Physics.formatTimeDisplay(dateStr, timeStr);
                const ts = Physics.getTimestamp(dateStr, timeStr);

                const vol = parseFloat(row[slot.colVol]);
                const amp = parseFloat(row[slot.colAmp]);
                let sheetSocRaw = row[slot.colSoc];
                if(sheetSocRaw && typeof sheetSocRaw === 'string') sheetSocRaw = sheetSocRaw.replace('%','');
                let sheetSoc = parseFloat(sheetSocRaw);
                if(!isNaN(sheetSoc) && sheetSoc <= 1.0 && sheetSoc > 0) sheetSoc = sheetSoc * 100;

                const status = (row[slot.colStat] || "IDLE").toUpperCase();

                if(!isNaN(vol) && !isNaN(amp)) {
                    let soc = isNaN(sheetSoc) ? Physics.calculateSoC(vol, specs.minV, specs.maxV) : sheetSoc;
                    const power = vol * amp;
                    const entry = { time: cleanTime, timestamp: ts, vol, amp, power, soc, status };
                    history.push(entry);
                    latest = entry;
                }
            }

            if(latest) {
                const energyAvailable = specs.idealWh * (latest.soc / 100);
                const dischargedWh = Physics.calculateTrapezoidalEnergy(history);

                Analytics.processRealtime(slot.id, latest, packCfg, specs);

                const slotHistory = AppState.cycleHistory.filter(c => c.slotId === slot.id);
                const currentSoH = slotHistory.length > 0 && slotHistory[0].soh !== "--" ? slotHistory[0].soh : "--";

                AppState.processedData[slot.id] = {
                    ...latest,
                    meta: { pack: packCfg, cell: cellCfg, parallel: specs.parallel, vRange: `${specs.minV.toFixed(1)}-${specs.maxV.toFixed(1)}V` },
                    energy: { available: energyAvailable, total: specs.idealWh, discharged: dischargedWh },
                    soh: currentSoH,
                    history
                };
            }
        });
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
            ...p
        }));
    }
    UI.renderSidebar();
    if (SYSTEM_CONFIG.url) API.startDataLoop(); else UI.openSettings();
};






















