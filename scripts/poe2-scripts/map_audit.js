/**
 * map_audit.js — MAP AUDIT FILE writer (mapper split, Phase 1).
 *
 * Only the file-writer lives here (no bus needed: fs + own buffer only). The START/END open-flush latches
 * (_auditOpen/_auditStartPending/_auditStartArea/_hoSelectedMapName/_mapTag) stay in mapper — they are
 * state-machine bookkeeping read/written by the spine + logMapSummary, and _mapTag also prefixes mapper's
 * console log lines.
 */

// ===== MAP AUDIT FILE (user: durable per-map record they can feed back later -- console truncates, disk log is
// dead). data\poe2-scripts\map_audit.log, two lines per map (START at objectives-readable, END from logMapSummary),
// wall-clock timestamps. fs has no append -> buffer + rewrite whole file (2 writes/map, trimmed to last 600 lines).
const MAP_AUDIT_FILE = 'map_audit.log';
let _auditLines = null;
export function mapAudit(line) {
  try {
    if (_auditLines === null) {
      let prev = '';
      try { prev = fs.readFile(MAP_AUDIT_FILE) || ''; } catch (e) {}
      _auditLines = prev ? String(prev).split('\n').filter(l => l.length) : [];
    }
    if (_auditLines.length > 600) _auditLines = _auditLines.slice(-600);
    const d = new Date();
    const p2 = n => (n < 10 ? '0' : '') + n;
    const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    _auditLines.push(`[${ts}] ${line}`);
    fs.writeFile(MAP_AUDIT_FILE, _auditLines.join('\n') + '\n');
  } catch (e) {}
}
