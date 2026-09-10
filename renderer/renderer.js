let STR = null; // 현재 언어의 문자열 사전 (main 프로세스가 'locale-data'로 보내줌)

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

// 고정(클릭스루) 토글 아이콘: 꺼짐=열린 자물쇠, 켜짐=잠긴 자물쇠. 걸쇠 모양만 다르고 나머지는 동일하다.
const LOCK_OPEN_SVG = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8-2"/></svg>';
const LOCK_CLOSED_SVG = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function colorFor(pct) {
  if (pct >= 90) return '#e53935';
  if (pct >= 75) return '#ffb300';
  return '#43a047';
}

function setRow(fillEl, pctEl, pct) {
  // 실측값이 없으면(pct === null) 0%처럼 보이는 가짜 값 대신 "데이터 없음"을 보여준다.
  if (pct == null) {
    fillEl.style.width = '0%';
    fillEl.style.backgroundColor = '#3a3d44';
    pctEl.textContent = STR ? STR.noData : '';
    pctEl.style.color = '#9aa0a6';
    return;
  }
  const clamped = Math.max(0, Math.min(pct, 100)); // 최대치는 100%로 고정 표시
  fillEl.style.width = clamped + '%';
  fillEl.style.backgroundColor = colorFor(clamped);
  pctEl.textContent = Math.round(clamped) + '%';
  pctEl.style.color = clamped >= 75 ? colorFor(clamped) : '#e6e6e6';
}

function formatRemaining(ms) {
  if (ms == null || !STR) return '';
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return fmt(STR.resetIn, { h: hours, m: minutes });
}

function formatRemainingWithDays(ms) {
  if (ms == null || !STR) return '';
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days > 0
    ? fmt(STR.resetInDays, { d: days, h: hours, m: minutes })
    : fmt(STR.resetIn, { h: hours, m: minutes });
}

const fiveHourFill = document.getElementById('fiveHourFill');
const fiveHourPct = document.getElementById('fiveHourPct');
const fiveHourResetInfo = document.getElementById('fiveHourResetInfo');
const weeklyFill = document.getElementById('weeklyFill');
const weeklyPct = document.getElementById('weeklyPct');
const weeklyResetInfo = document.getElementById('weeklyResetInfo');
const updatedEl = document.getElementById('updated');
const infoBtn = document.getElementById('infoBtn');
const settingsBtn = document.getElementById('settingsBtn');
const clickThroughBtn = document.getElementById('clickThroughBtn');
const closeBtn = document.getElementById('closeBtn');
const safeControls = document.getElementById('safeControls');
const titleText = document.getElementById('titleText');
const fiveHourLabel = document.getElementById('fiveHourLabel');
const thisWeekLabel = document.getElementById('thisWeekLabel');

infoBtn.addEventListener('click', () => window.api.openDetailWindow());
settingsBtn.addEventListener('click', () => window.api.openCalibrateWindow());
clickThroughBtn.addEventListener('click', () => window.api.toggleClickThrough());
closeBtn.addEventListener('click', () => window.api.quitApp());

// 클릭스루가 켜져 있으면 메인 프로세스는 기본적으로 마우스를 전부 통과시키고 hover만 감지한다.
// safeControls(마우스 통과 버튼 하나)에 마우스가 있을 때만 알려줘서 그 순간에만 클릭이 실제로 위젯에 닿게 한다.
// 설정/정보/종료 버튼은 일부러 이 영역 밖에 둬서, 고정(클릭스루) 모드에서는 마우스 통과 버튼 외 아무것도 눌리지 않게 한다.
let hoveringSafeControls = false;
let clickThroughState = false;
safeControls.addEventListener('mouseenter', () => {
  hoveringSafeControls = true;
  window.api.setClickThroughHover(true);
});
safeControls.addEventListener('mouseleave', () => {
  hoveringSafeControls = false;
  window.api.setClickThroughHover(false);
});

function applyClickThroughState(enabled) {
  clickThroughState = enabled;
  clickThroughBtn.classList.toggle('active', enabled);
  clickThroughBtn.innerHTML = enabled ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
  if (STR) clickThroughBtn.title = enabled ? STR.tooltipClickThroughOn : STR.tooltipClickThroughOff;
  // 버튼을 누른 순간 이미 safeControls 위에 마우스가 있었다면(mouseenter가 다시 발생하지 않으므로)
  // 방금 켠 직후에도 계속 클릭 가능하도록 호버 상태를 다시 알려준다.
  if (enabled && hoveringSafeControls) window.api.setClickThroughHover(true);
}

function applyLocale(data) {
  STR = data.strings;
  document.documentElement.lang = data.lang;
  document.title = STR.widgetWindowTitle;
  titleText.textContent = STR.appTitle;
  fiveHourLabel.textContent = STR.fiveHourLabel;
  thisWeekLabel.textContent = STR.thisWeekLabel;
  settingsBtn.title = STR.tooltipSettings;
  infoBtn.title = STR.tooltipDetail;
  closeBtn.title = STR.tooltipClose;
  clickThroughBtn.title = clickThroughState ? STR.tooltipClickThroughOn : STR.tooltipClickThroughOff;
}

window.api.onLocaleData(applyLocale);

window.api.onClickThroughState(applyClickThroughState);
window.api.getClickThroughState().then(applyClickThroughState);

window.api.onUsageUpdate((data) => {
  setRow(fiveHourFill, fiveHourPct, data.fiveHourPct);
  setRow(weeklyFill, weeklyPct, data.weeklyPct);
  fiveHourResetInfo.textContent = data.fiveHourPending
    ? (STR ? STR.resetPending : '')
    : formatRemaining(data.fiveHourResetInMs);
  weeklyResetInfo.textContent = formatRemainingWithDays(data.weeklyResetInMs);
  const d = new Date(data.updatedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  updatedEl.textContent = STR ? fmt(STR.updatedAt, { hh, mm }) : '';
});
