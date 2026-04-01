function doGet(e) {
  Logger.log(JSON.stringify(e));

  var sheetId = '104DqeQkd4wlIcJ9ofmA6McDuomP983_G5c13JksjFe4';
  var ss = SpreadsheetApp.openById(sheetId);
  var monitoringSheet = ss.getSheetByName('prasimax_monitoring');
  var controlSheet = ss.getSheetByName('prasimax_control');
  var timeZone = 'Asia/Bangkok';

  // Ensure header row exists
  setupMonitoringSheet(monitoringSheet);

  // ── READ MODE ──────────────────────────────────────────────────────────────
  // Dashboard calls ?mode=read to fetch ALL historical monitoring data as CSV.
  // Returns the entire prasimax_monitoring sheet so the dashboard has full history.
  if (e && e.parameter && e.parameter.mode === 'read') {
    var allData = monitoringSheet.getDataRange().getValues();
    var csv = allData.map(function(row) {
      return row.map(function(cell) {
        if (cell instanceof Date) {
          return Utilities.formatDate(cell, timeZone, 'M/d/yyyy HH:mm:ss');
        }
        var str = String(cell);
        if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(',');
    }).join('\n');

    return ContentService
      .createTextOutput(csv)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  //ALERT MODE

  if (e && e.parameter && e.parameter.mode === 'alert') {
    var msg = e.parameter.msg || 'Unknown alert';
    var recipient = 'zli37836@gmail.com'; // ← CHANGE THIS to real email
    var subject = '⚠ BSS ALERT: ' + msg.substring(0, 80);
    var body = 'BSS Monitoring Alert\n\n'
        + 'Time: ' + Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd HH:mm:ss') + '\n'
        + 'Message: ' + msg + '\n\n'
        + 'Please check the BSS dashboard for details.';

    try {
      MailApp.sendEmail(recipient, subject, body);
      return ContentService.createTextOutput('ALERT_SENT').setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
      Logger.log('Alert email failed: ' + err);
      return ContentService.createTextOutput('ALERT_FAILED').setMimeType(ContentService.MimeType.TEXT);
    }
  }

  // ── CONTROL COMMANDS ───────────────────────────────────────────────────────
  // Read battery commands from prasimax_control sheet (A2=bat1, B2=bat2)
  var cmd1 = 'Idle';
  var cmd2 = 'Idle';
  if (controlSheet) {
    var ctrl = controlSheet.getRange('A2:B2').getValues()[0];
    cmd1 = normalizeText(ctrl[0]) || 'Idle';
    cmd2 = normalizeText(ctrl[1]) || 'Idle';
  }
  var responseBody = cmd1 + ',' + cmd2;

  // ── NO PARAMS (ESP32 polling for commands) ─────────────────────────────────
  if (!e || !e.parameter || Object.keys(e.parameter).length === 0) {
    return ContentService
      .createTextOutput(responseBody)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // ── WRITE MODE (ESP32 sending sensor data) ─────────────────────────────────
  // Column order: A=Date, B=Time, C=Voltage1, D=Current1, E=Status1,
  //               F=Voltage2, G=Current2, H=Status2, I=BAT1%, J=BAT2%
  var now = new Date();
  var rowData = [
    Utilities.formatDate(now, timeZone, 'M/d/yyyy'),
    Utilities.formatDate(now, timeZone, 'H:mm:ss'),
    getNumberParam(e, 'volt1'),
    getNumberParam(e, 'amp1'),
    getTextParam(e, 'status1'),
    getNumberParam(e, 'volt2'),
    getNumberParam(e, 'amp2'),
    getTextParam(e, 'status2')
  ];

  var newRow = monitoringSheet.getLastRow() + 1;
  monitoringSheet.getRange(newRow, 1, 1, rowData.length).setValues([rowData]);

  // Auto-fill BAT% formulas in columns I and J
  monitoringSheet.getRange(newRow, 9).setFormula(buildBatteryPercentFormula('C' + newRow));
  monitoringSheet.getRange(newRow, 10).setFormula(buildBatteryPercentFormula('F' + newRow));

  Logger.log('Row Data: ' + JSON.stringify(rowData));

  return ContentService
    .createTextOutput(responseBody)
    .setMimeType(ContentService.MimeType.TEXT);
}

// ── SHEET SETUP ──────────────────────────────────────────────────────────────
function setupMonitoringSheet(sheet) {
  var headers = [
    'Date', 'Time',
    'Voltage1', 'Current1', 'Status1',
    'Voltage2', 'Current2', 'Status2',
    'BAT1 %', 'BAT2 %'
  ];
  var currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var needsHeader = false;
  for (var i = 0; i < headers.length; i++) {
    if (currentHeaders[i] !== headers[i]) { needsHeader = true; break; }
  }
  if (needsHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

// ── BAT% FORMULA ─────────────────────────────────────────────────────────────
// Linear estimate: 60V = 0%, 72V = 100%, clamped [0, 100]
function buildBatteryPercentFormula(voltageCell) {
  return '=IF(' + voltageCell + '="","",IF(((' + voltageCell + '-60)/(72-60)*100)<0,0,IF(((' + voltageCell + '-60)/(72-60)*100)>100,100,((' + voltageCell + '-60)/(72-60)*100))))';
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getTextParam(e, key) {
  if (!e || !e.parameter || e.parameter[key] === undefined || e.parameter[key] === null) return '';
  return normalizeText(e.parameter[key]);
}

function getNumberParam(e, key) {
  if (!e || !e.parameter || e.parameter[key] === undefined || e.parameter[key] === null) return '';
  var value = normalizeText(e.parameter[key]);
  if (value === '') return '';
  var num = Number(value);
  return isNaN(num) ? '' : num;
}

function normalizeText(value) {
  return String(value).replace(/^["']|['"]$/g, '').trim();
}
