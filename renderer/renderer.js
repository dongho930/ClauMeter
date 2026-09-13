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

// 남은 시간 대비 적정 사용률(기준선)을 게이지에 표시한다. pct(현재 사용률)나 pacePct(기준)가 없으면
// 둘 다 숨긴다 - 비교 대상이 없는 기준선만 덩그러니 남으면 남은 시간 표시와 중복되기만 한다.
//
// 기준선을 넘었다는 건 "남은 시간을 다 채우기 전에 한도가 바닥난다"는 뜻이라 경고색(노랑)을 쓰고,
// 아래에 있으면 평상시 회색이다. 채움(.fill) 자체의 색은 건드리지 않는다 - 그건 한도까지의 절대
// 거리를 나타내는 신호라서, 페이스 이탈로 덮어쓰면 정작 "한도에 가깝다"는 정보가 사라진다.
function setPace(tickEl, infoEl, pct, pacePct) {
  if (pct == null || pacePct == null) {
    tickEl.hidden = true;
    infoEl.textContent = '';
    return;
  }
  const clampedPace = Math.max(0, Math.min(pacePct, 100));
  tickEl.hidden = false;
  tickEl.style.left = clampedPace + '%';

  // 0.4%p 같은 미세한 변동에 부호가 깜빡이지 않도록 반올림한 값으로만 판정한다. (-0은 0으로 정규화)
  const delta = Math.round(pct - pacePct) || 0;
  infoEl.textContent = STR
    ? fmt(STR.paceInfo, { p: Math.round(pacePct), d: (delta > 0 ? '+' : '') + delta })
    : '';
  infoEl.style.color = delta > 0 ? '#ffb300' : '#9aa0a6';
}

// 헤더의 페이스 상태 표시. 5시간과 주간을 따로 보여준다 - 한 곳에 하나만 두면 둘 중 하나밖에
// 표현하지 못한다. 색상 판정은 언어와 무관한 영어 코드로만 하고(상세창과 같은 규칙), 한도 이름은
// 게이지에 이미 쓰는 문자열을 그대로 재사용해서 번역을 새로 만들지 않는다.
//
// 게이지 행 안에 두지 않고 헤더에 모은 이유: 행에는 이미 막대 색(절대 사용률)과 기준선 초과
// 표시가 있어서, 기준이 다른 색이 서로 붙어 있으면 같은 행이 두 가지로 말하는 것처럼 보인다.
const PACE_RISK_COLOR = { safe: '#43a047', caution: '#ffb300', danger: '#e53935' };

// 상태에 따라 변하는 건 점 색깔 하나뿐이다. 한도 이름은 언제나 같은 회색 보통 글씨로 둔다.
function setPaceState(stateEl, labelEl, dotEl, label, risk) {
  if (!risk || !PACE_RISK_COLOR[risk]) {
    stateEl.hidden = true;
    return;
  }
  stateEl.hidden = false;
  labelEl.textContent = label;
  dotEl.style.backgroundColor = PACE_RISK_COLOR[risk];
}

function setPaceStates(data) {
  if (!STR) return;
  setPaceState(fiveHourState, fiveHourStateLabel, fiveHourStateDot, STR.fiveHourLabel, data.fiveHourRisk);
  setPaceState(weeklyState, weeklyStateLabel, weeklyStateDot, STR.thisWeekLabel, data.weeklyRisk);
  // 양쪽 다 보여줄 게 없으면 묶음째 숨겨서 헤더에 빈 자리가 남지 않게 한다.
  paceStates.hidden = fiveHourState.hidden && weeklyState.hidden;
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
const fiveHourPaceTick = document.getElementById('fiveHourPaceTick');
const fiveHourPaceInfo = document.getElementById('fiveHourPaceInfo');
const weeklyFill = document.getElementById('weeklyFill');
const weeklyPct = document.getElementById('weeklyPct');
const weeklyResetInfo = document.getElementById('weeklyResetInfo');
const weeklyPaceTick = document.getElementById('weeklyPaceTick');
const weeklyPaceInfo = document.getElementById('weeklyPaceInfo');
const paceStates = document.getElementById('paceStates');
const fiveHourState = document.getElementById('fiveHourState');
const fiveHourStateLabel = document.getElementById('fiveHourStateLabel');
const fiveHourStateDot = document.getElementById('fiveHourStateDot');
const weeklyState = document.getElementById('weeklyState');
const weeklyStateLabel = document.getElementById('weeklyStateLabel');
const weeklyStateDot = document.getElementById('weeklyStateDot');
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
  setPace(fiveHourPaceTick, fiveHourPaceInfo, data.fiveHourPct, data.fiveHourPacePct);
  setPace(weeklyPaceTick, weeklyPaceInfo, data.weeklyPct, data.weeklyPacePct);
  setPaceStates(data);
  fiveHourResetInfo.textContent = data.fiveHourPending
    ? (STR ? STR.resetPending : '')
    : formatRemaining(data.fiveHourResetInMs);
  weeklyResetInfo.textContent = formatRemainingWithDays(data.weeklyResetInMs);
  const d = new Date(data.updatedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  updatedEl.textContent = STR ? fmt(STR.updatedAt, { hh, mm }) : '';
});
