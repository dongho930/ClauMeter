const { app, BrowserWindow, Menu, screen, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const costStore = require('./costStore');
const configStore = require('./configStore');
const usageModel = require('./usageModel');
const realtimeUsage = require('./realtimeUsage');
const usageHistory = require('./usageHistory');
const updater = require('./updater');
const { LOCALES, SUPPORTED_LANGUAGES, LANGUAGE_NAME_EN, DEFAULT_LANGUAGE, t } = require('./locales');

// 일부 환경(하드웨어 가속/샌드박스 제한)에서 GPU 프로세스가 죽는 문제를 피하기 위한 안전장치
app.disableHardwareAcceleration();

// Windows 토스트 알림에 "Electron" 대신 이 앱의 이름/아이콘이 뜨도록 등록한다 (package.json의 appId와 동일해야 함).
// Windows 전용 API라서 다른 OS에서는 호출하지 않는다 (macOS 알림은 앱 번들의 이름/아이콘을 쓴다).
if (process.platform === 'win32') app.setAppUserModelId('com.claumeter.app');

const POLL_INTERVAL_MS = 1_000;
const WEEK_MS = 7 * 86400 * 1000;
const FIVE_HOUR_MS = 5 * 3600 * 1000;
const NOTIFY_THRESHOLDS = [50, 75, 90];

const WIDGET_WIDTH = 340;
const WIDGET_HEIGHT = 160;
const BOTTOM_MARGIN = 56;
// 아래 세 값은 Electron의 실제 opacity(불투명도, 1이 완전히 또렷함)다. 설정창 슬라이더는 반대 개념인
// "투명도"를 보여주므로 calibrate.js가 1-opacity로 뒤집어서 표시/입력한다.
const DEFAULT_OPACITY = 1.0; // 기본값 = 투명도 0%(완전히 또렷하게 보이는 상태)
const MIN_OPACITY = 0.5; // 실제 opacity 하한선 = 투명도 최대 50%(그 이상 투명해지면 위젯이 거의 안 보임)
const MAX_OPACITY = 1.0; // 실제 opacity 상한선 = 투명도 최소 0%(완전 불투명 허용)

const ICON_PATH = path.join(__dirname, 'build', 'icon.ico');

// AI 조언은 Groq를 직접 호출하지 않고 이 프록시를 거친다 - Groq 키는 서버에만 있고 앱 안에는
// 전혀 들어가지 않는다(배포되는 앱 코드를 누가 열어봐도 키가 없다). proxy-server/README.md 참고.
const PROXY_URL = 'https://claumeter-proxy-server.vercel.app/api/advice';
const ADVICE_CACHE_MS = 5 * 60 * 1000;

let mainWindow = null;
let calibrateWindow = null;
let detailWindow = null;
let pollTimer = null;
let cfg = configStore.loadConfig();
let adviceCache = null; // { text, stats, computedAt }
let clickThroughEnabled = false; // 켜지면 헤더 버튼 영역을 제외한 위젯 전체가 마우스 클릭을 그대로 통과시킴

// 클릭스루가 켜져 있을 때는 기본적으로 전체를 통과시키고(forward:true로 hover는 계속 감지),
// 렌더러가 헤더 버튼 위에 마우스가 올라왔다고 알려줄 때만 일시적으로 상호작용을 되살린다.
function applyClickThroughState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (clickThroughEnabled) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getConfiguredOpacity() {
  const v = cfg.windowOpacity;
  if (typeof v !== 'number' || Number.isNaN(v)) return DEFAULT_OPACITY;
  return clamp(v, MIN_OPACITY, MAX_OPACITY);
}

function broadcastClickThroughState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clickthrough:state', clickThroughEnabled);
  }
}

// cfg.language가 지원 언어면 그대로 쓰고, 아니면(최초 실행 등) 항상 DEFAULT_LANGUAGE(영어)로 시작한다 -
// OS 로케일로 자동 추정하지 않는다. 사용자가 설정 창에서 언어를 고르면 그 값이 cfg.language에
// 저장되어 이후에도 계속 그 언어로 유지된다.
function resolveLanguage() {
  if (cfg.language && LOCALES[cfg.language]) return cfg.language;
  return DEFAULT_LANGUAGE;
}

function L(key, vars) {
  return t(resolveLanguage(), key, vars);
}

function localePayload() {
  return { lang: resolveLanguage(), strings: LOCALES[resolveLanguage()], languages: SUPPORTED_LANGUAGES };
}

function sendLocale(win) {
  if (win && !win.isDestroyed()) win.webContents.send('locale-data', localePayload());
}

// 언어가 바뀌면 열려 있는 모든 창에 새 문자열을 다시 보내고, 프레임이 있는 창들의 타이틀바 텍스트도 갱신한다.
function broadcastLocale() {
  sendLocale(mainWindow);
  sendLocale(detailWindow);
  sendLocale(calibrateWindow);
  if (detailWindow && !detailWindow.isDestroyed()) detailWindow.setTitle(L('detailWindowTitle'));
  if (calibrateWindow && !calibrateWindow.isDestroyed()) calibrateWindow.setTitle(L('settingsWindowTitle'));
}

// 주간 초기화 시각(cfg.weekResetAt)을 지났으면 7일 단위로 계속 앞으로 넘겨서
// "현재 주간 구간"이 항상 지금을 포함하도록 맞춘다. (여러 주가 지나도 안전)
function advanceWeekResetIfNeeded() {
  if (cfg.weekResetAt == null) return;
  const now = Date.now();
  let changed = false;
  while (now >= cfg.weekResetAt) {
    // 방금 끝난 구간을 개인화 모델의 학습 데이터로 반영한다 (구간이 끝나야 최종값을 알 수 있으므로 여기서만 학습).
    const oldWindowStart = cfg.weekResetAt - WEEK_MS;
    const oldWindowEnd = cfg.weekResetAt;
    usageModel.closeWindow('weekly', costStore.getCostBetween(oldWindowStart / 1000, oldWindowEnd / 1000));

    cfg.weekResetAt += WEEK_MS;
    changed = true;
  }
  if (changed) configStore.saveConfig(cfg);
}

// 실제 Claude의 5시간 한도는 "직전 구간이 끝난 뒤 처음 메시지를 보낸 시점"에 새로 시작된다.
// 그래서 단순히 시계처럼 5시간씩 기계적으로 미루지 않고, 구간이 만료된 뒤 실제로 발생한
// 첫 사용 이벤트(costStore가 기록한 실비용 이벤트 = 메시지 응답 시점)를 찾아 그 시각을 새 구간의
// 시작으로 삼는다. 만료 이후 아직 메시지가 없다면 새 구간은 "대기" 상태로 남겨두고, 다음 폴링에서
// 다시 확인한다.
function advanceFiveHourResetIfNeeded() {
  if (cfg.fiveHourResetAt == null) return;
  const now = Date.now();
  let changed = false;
  while (now >= cfg.fiveHourResetAt) {
    // 방금 끝난 구간을 개인화 모델의 학습 데이터로 반영한다 (구간이 끝나야 최종값을 알 수 있으므로 여기서만 학습).
    const oldWindowStart = cfg.fiveHourResetAt - FIVE_HOUR_MS;
    const oldWindowEnd = cfg.fiveHourResetAt;
    usageModel.closeWindow('fiveHour', costStore.getCostBetween(oldWindowStart / 1000, oldWindowEnd / 1000));

    const nextEventSec = costStore.getEarliestEventAfter(cfg.fiveHourResetAt / 1000);
    if (nextEventSec == null) {
      if (!cfg.fiveHourWindowPending) changed = true;
      cfg.fiveHourWindowPending = true;
      break;
    }
    cfg.fiveHourResetAt = nextEventSec * 1000 + FIVE_HOUR_MS;
    cfg.fiveHourWindowPending = false;
    changed = true;
  }
  if (changed) configStore.saveConfig(cfg);
}

function currentWeekStartMs() {
  return cfg.weekResetAt != null ? cfg.weekResetAt - WEEK_MS : Date.now() - WEEK_MS;
}

function currentFiveHourStartMs() {
  return cfg.fiveHourResetAt != null ? cfg.fiveHourResetAt - FIVE_HOUR_MS : Date.now() - FIVE_HOUR_MS;
}

// 마지막 사용 이후 흐른 시간(초). 개인화 모델이 "이 구간의 사용이 이미 끝났는지" 판단하는 데 쓴다.
// 사용 기록이 아직 없으면 null - 이 경우 모델은 유휴 보정 없이 곡선 예측을 그대로 쓴다.
function currentIdleSec() {
  const lastSec = costStore.getLatestEventTs();
  return lastSec != null ? Math.max(0, Date.now() / 1000 - lastSec) : null;
}

// 남은 시간 대비 "지금쯤 여기까지 써도 되는" 기준 사용률(%). 구간 전체를 균등하게 나눠 쓴다고 본
// 선형 예산선이라, 학습 모델과 무관하게 구간 첫 순간부터 항상 계산된다(데드존/표본 부족이 없다).
//
// 학습된 곡선(usageModel)을 여기 쓰면 안 된다. 그 곡선은 "평소 이 시점에 어디까지 썼나"(서술)라서
// 5시간 구간은 경과율 50%에서 이미 90% 소진이 평균이다 - 기준선으로 쓰면 "2시간 반 지났으니 90%까지
// 써도 정상"이라고 안내하게 된다. 기준선이 답해야 하는 건 "한도를 넘지 않으려면 어디여야 하나"(규범)
// 라서 성격이 정반대다. 곡선 기반 예측은 상세창의 "예상 마감 사용률"이 따로 담당한다.
function pacePctFromResetIn(resetInMs, windowMs) {
  if (resetInMs == null) return null;
  const elapsedMs = Math.max(0, Math.min(windowMs, windowMs - resetInMs));
  return Math.round((elapsedMs / windowMs) * 1000) / 10;
}

// Anthropic 서버가 알려준 실제 초기화 시각(realtime.*.resetsAt)으로 cfg의 초기화 시각을 맞춘다.
// cfg.fiveHourResetAt/weekResetAt은 화면 표시뿐 아니라 구간 경계(currentFiveHourStartMs 등) 계산에도
// 쓰이므로, 실측값이 있는데도 내부적으로는 보정(calibrate) 추정치를 계속 쓰면 표시값과 실제 집계 구간이
// 어긋난다. 실측값이 들어올 때마다 cfg를 실제 값으로 덮어써서 항상 실제 초기화 시각을 기준으로 삼는다.
function syncResetTimesFromRealtime(realtime) {
  let changed = false;
  if (realtime.fiveHour && cfg.fiveHourResetAt !== realtime.fiveHour.resetsAt) {
    cfg.fiveHourResetAt = realtime.fiveHour.resetsAt;
    if (cfg.fiveHourWindowPending) cfg.fiveHourWindowPending = false;
    changed = true;
  }
  if (realtime.weekly && cfg.weekResetAt !== realtime.weekly.resetsAt) {
    cfg.weekResetAt = realtime.weekly.resetsAt;
    changed = true;
  }
  if (changed) {
    configStore.saveConfig(cfg);
    // 주간 초기화 시각을 이제 막 알게 됐다면, 위상을 몰라 보류해둔 주간 백필을 여기서 수행한다.
    // (이미 끝났으면 즉시 반환하므로 매주 초기화 시각이 갱신될 때마다 호출돼도 부담이 없다.)
    backfillUsageModelIfNeeded();
  }
}

function computePercents() {
  costStore.scanAndUpdate();
  const realtime = realtimeUsage.read();
  // 실측 %는 덮어쓰기로만 남아서 지나간 값을 볼 수 없었다. 이력을 남겨야 "비용이 한도 소모의
  // 올바른 대리 지표인가", "모델마다 $1이 한도를 깎는 정도가 다른가" 같은 질문에 나중에 답할 수 있다.
  // 예측 동작에는 영향을 주지 않는다 (기록만 한다).
  usageHistory.record(realtime);
  syncResetTimesFromRealtime(realtime);
  advanceWeekResetIfNeeded();
  advanceFiveHourResetIfNeeded();

  const fiveHourPending = !!cfg.fiveHourWindowPending;
  const fiveHourCost = fiveHourPending ? 0 : costStore.getCostSince(currentFiveHourStartMs() / 1000);
  const weeklyCost = costStore.getCostSince(currentWeekStartMs() / 1000);

  // 진행 중인 구간의 (경과율 -> 누적비용) 샘플을 모아둔다. 구간이 끝나는 시점에만 실제 학습에 반영된다.
  // (이 학습은 "예상 마감 사용률" 예측용이고, 화면에 보여주는 현재 사용률과는 무관하다.)
  const idleSec = currentIdleSec();
  if (!fiveHourPending) {
    usageModel.recordSample(
      'fiveHour',
      (Date.now() - currentFiveHourStartMs()) / FIVE_HOUR_MS,
      fiveHourCost,
      idleSec
    );
  }
  usageModel.recordSample('weekly', (Date.now() - currentWeekStartMs()) / WEEK_MS, weeklyCost, idleSec);

  // Claude Code 터미널의 statusLine 훅(statuslineBridge.js)이 남겨둔, Anthropic 서버가 직접 계산한
  // 실제 한도 %만 현재 사용률로 쓴다. 비용 기반 추정은 부정확해서 더 이상 대체값으로 쓰지 않으며,
  // 실측값이 없으면 null을 그대로 돌려줘서 화면이 "데이터 없음"으로 표시하게 한다.
  const fiveHourRealPct = !fiveHourPending && realtime.fiveHour ? realtime.fiveHour.usedPercentage : null;
  const weeklyRealPct = realtime.weekly ? realtime.weekly.usedPercentage : null;

  const fiveHourResetInMs = !fiveHourPending
    ? realtime.fiveHour
      ? Math.max(0, realtime.fiveHour.resetsAt - Date.now())
      : cfg.fiveHourResetAt != null
        ? Math.max(0, cfg.fiveHourResetAt - Date.now())
        : null
    : null;
  const weeklyResetInMs = realtime.weekly
    ? Math.max(0, realtime.weekly.resetsAt - Date.now())
    : cfg.weekResetAt != null
      ? Math.max(0, cfg.weekResetAt - Date.now())
      : null;

  return {
    fiveHourPct: fiveHourPending ? 0 : fiveHourRealPct,
    fiveHourHasData: fiveHourPending || fiveHourRealPct != null,
    fiveHourPending,
    weeklyPct: weeklyRealPct,
    weeklyHasData: weeklyRealPct != null,
    fiveHourResetInMs,
    weeklyResetInMs,
    // 게이지에 그릴 기준선. 아직 시작 안 한 5시간 구간(fiveHourPending)은 경과 자체가 없으므로 null.
    fiveHourPacePct: fiveHourPending ? null : pacePctFromResetIn(fiveHourResetInMs, FIVE_HOUR_MS),
    weeklyPacePct: pacePctFromResetIn(weeklyResetInMs, WEEK_MS),
    updatedAt: Date.now(),
  };
}

function ensureNotifiedThresholdsState() {
  if (!cfg.notifiedThresholds) {
    cfg.notifiedThresholds = {
      fiveHour: { resetAt: null, fired: [] },
      weekly: { resetAt: null, fired: [] },
    };
  }
  return cfg.notifiedThresholds;
}

function sendUsageNotification(body) {
  if (!Notification.isSupported()) return;
  new Notification({ title: L('appTitle'), body, icon: ICON_PATH }).show();
}

// 5시간/주간 사용률이 50/75/90%를 막 넘었을 때 한 번씩 토스트 알림을 띄운다. "이미 울린 임계값"은
// cfg.notifiedThresholds에 구간(resetAt) 단위로 저장해두므로, 앱을 껐다 켜도 같은 구간 안에서는
// 중복 알림이 뜨지 않는다. 구간이 끝나고 새 구간이 시작되면(resetAt 변경) 자동으로 초기화된다.
function checkUsageThresholds(p) {
  if (!cfg.notificationsEnabled) return;
  const state = ensureNotifiedThresholdsState();
  let changed = false;

  function checkOne(hasData, pct, resetAt, kind, bodyKey) {
    if (!hasData || pct == null || resetAt == null) return;
    const entry = state[kind];
    if (entry.resetAt !== resetAt) {
      entry.resetAt = resetAt;
      entry.fired = [];
      changed = true;
    }
    for (const threshold of NOTIFY_THRESHOLDS) {
      if (pct >= threshold && !entry.fired.includes(threshold)) {
        entry.fired.push(threshold);
        changed = true;
        sendUsageNotification(L(bodyKey, { pct: threshold }));
      }
    }
  }

  checkOne(p.fiveHourHasData, p.fiveHourPct, cfg.fiveHourResetAt, 'fiveHour', 'notifyFiveHourBody');
  checkOne(p.weeklyHasData, p.weeklyPct, cfg.weekResetAt, 'weekly', 'notifyWeeklyBody');

  if (changed) configStore.saveConfig(cfg);
}

function formatHM(ms) {
  if (ms == null) return L('unknownDuration');
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days > 0
    ? L('durationDHM', { d: days, h: hours, m: minutes })
    : L('durationHM', { h: hours, m: minutes });
}

// 한 한도의 예측을 계산한다. computePercents()가 이미 만든 값만 받아서 부수효과 없이 동작하므로,
// 1초 폴링 루프(위젯 배지)와 상세창(조언 카드)이 computePercents()를 두 번 돌리지 않고 같이 쓴다.
//
// 이번 구간 시작부터 지금까지의 페이스가 끝까지 이어진다고 가정했을 때 도달할 사용률(%)을 추정한다.
// 개인화 모델이 충분히 학습되어 있으면 그 곡선으로 예측하고, 데이터가 부족하면 단순 선형으로 대체한다.
//
// timeToLimitMs와 slowdownRatio는 같은 비율 r에서 나온다.
//   r = (100 - 현재%) / (예상마감% - 현재%)   = 남은 구간에서 쓸 수 있는 몫이 예상 소비량 중 차지하는 비율
//   - 한도 도달까지 남은 시간 = 남은 시간 x r   (남은 구간에 페이스가 고르게 이어진다고 볼 때)
//   - 구간 끝까지 버티려면 줄여야 할 속도 = 지금 페이스의 r
// 같은 r에서 나오므로 "2시간 뒤 도달"과 "속도를 60%로"가 서로 어긋날 수 없다.
// 예상 마감이 100% 이하면 이 구간에서는 한도에 닿지 않으므로 둘 다 null이다.
function projectLimit(kind, windowMs, pct, resetInMs, cost, idleSec) {
  // 아직 시작하지 않은 5시간 구간은 resetInMs가 null이라 여기서 자연히 전부 null이 된다.
  const elapsedMs = resetInMs != null ? Math.max(0, windowMs - resetInMs) : null;
  const elapsedFrac = elapsedMs != null ? elapsedMs / windowMs : null;

  const modelPred =
    elapsedMs != null ? usageModel.predictFinalCost(kind, elapsedFrac, cost, idleSec) : null;

  // "페이스 배율" = 지금 페이스가 유지되면 최종적으로 지금의 몇 배가 될지. 비율이라 단위와 무관하므로
  // 실제 % (ground truth)에 그대로 곱해 "예상 마감 %"를 구한다. 현재 %가 실측값 없이 null이면
  // 곱할 기준값 자체가 없으므로 예측도 계산하지 않는다(추정치로 대체하지 않음).
  const paceMultiplier = modelPred != null && cost > 0 ? modelPred / cost : null;

  // 구간 초반에는 모델이든 단순 폴백이든 예측이 의미 없는 수준이라 아예 내보내지 않는다
  // (usageModel.isProjectionReliable 참고). 주간 한도는 완료 구간이 하나뿐이라 같은 임계값을
  // 검증하지 못했지만, "구간의 1/4도 안 지난 시점의 외삽은 못 믿는다"는 근거는 구간 길이와 무관하다.
  let projectedPct = null;
  if (pct != null && usageModel.isProjectionReliable(elapsedFrac)) {
    const multiplier = paceMultiplier != null ? paceMultiplier : 1 / elapsedFrac;
    projectedPct = Math.round(pct * multiplier * 10) / 10;
  }

  let timeToLimitMs = null;
  let slowdownRatio = null;
  if (projectedPct != null && projectedPct > 100 && resetInMs != null) {
    // projectedPct > 100 >= pct 이므로 분모는 항상 0보다 크다. 이미 한도에 닿았으면(pct >= 100) r = 0.
    const r = pct >= 100 ? 0 : (100 - pct) / (projectedPct - pct);
    timeToLimitMs = Math.round(resetInMs * r);
    slowdownRatio = r;
  }

  return { elapsedMs, projectedPct, modelBased: modelPred != null, timeToLimitMs, slowdownRatio };
}

function computeAdviceStats() {
  const p = computePercents();

  // 유휴시간이 길면 이 구간의 사용이 사실상 끝난 것으로 보고 예측을 현재값 쪽으로 당긴다.
  // (곡선 모델만으로는 "이미 끝난 구간"을 표현할 수 없어 구조적으로 과대예측된다 - usageModel 참고.)
  const idleSec = currentIdleSec();
  const fiveHour = projectLimit(
    'fiveHour',
    FIVE_HOUR_MS,
    p.fiveHourPct,
    p.fiveHourResetInMs,
    p.fiveHourPending ? 0 : costStore.getCostSince(currentFiveHourStartMs() / 1000),
    idleSec
  );
  const weekly = projectLimit(
    'weekly',
    WEEK_MS,
    p.weeklyPct,
    p.weeklyResetInMs,
    costStore.getCostSince(currentWeekStartMs() / 1000),
    idleSec
  );

  // 속도 배율은 화면에 %로 보이므로 여기서 정수 %로 굳힌다. 0%는 "멈추라"는 뜻이 되어버려서 최소 1%.
  const slowdownPct = (ratio) => (ratio == null ? null : Math.max(1, Math.round(ratio * 100)));

  // 두 한도를 잇는 환산. 표본이 부족하면 비율이 null이고, 아래 값들도 전부 null이 되어 화면에서 숨는다.
  const perFiveHour = usageHistory.getWeeklyPerFiveHourRatio();
  // 5시간 한도를 0%에서 100%까지 꽉 채울 때 깎이는 주간 %p. 화면에 보이는 "구간 1번분"의 단위다.
  const weeklyCostOfFullWindow = perFiveHour != null ? perFiveHour * 100 : null;
  const canConvert = weeklyCostOfFullWindow > 0 && p.weeklyPct != null;

  // (B) 남은 주간 여유가 5시간 구간 몇 번분인지, 그리고 남은 기간 동안 하루 몇 번 꼴인지.
  const weeklyHeadroomPct = p.weeklyPct != null ? Math.max(0, Math.round((100 - p.weeklyPct) * 10) / 10) : null;
  const weeklyWindowsLeft = canConvert ? weeklyHeadroomPct / weeklyCostOfFullWindow : null;
  // 달력상 남은 5시간 슬롯 수는 쓰지 않는다 - 자는 시간이 전부 포함돼서 의미가 없다. 대신 "하루 몇 번
  // 꼴"로 환산한다. 남은 기간이 반나절도 안 되면 하루 단위 환산 자체가 과장되므로 그때는 내보내지 않는다.
  const weeklyDaysLeft = p.weeklyResetInMs != null ? p.weeklyResetInMs / 86400000 : null;
  const weeklyWindowsPerDay =
    weeklyWindowsLeft != null && weeklyDaysLeft != null && weeklyDaysLeft >= 0.5
      ? Math.round((weeklyWindowsLeft / weeklyDaysLeft) * 10) / 10
      : null;

  // (C) 지금 5시간 구간을 100%까지 쓰면 이번 주가 몇 %가 되는지. 5시간 게이지만 보면 여유로워 보여도
  // 그 여유를 다 쓰면 주간이 어디까지 가는지가 실제로 중요한 판단 재료다.
  const weeklyIfFiveHourFull =
    canConvert && p.fiveHourPct != null && !p.fiveHourPending && p.fiveHourPct < 100
      ? Math.round((p.weeklyPct + perFiveHour * (100 - p.fiveHourPct)) * 10) / 10
      : null;

  // 상세창도 위젯과 똑같은 상태(안전/주의/위험)를 쓴다. 판정 규칙을 렌더러에 다시 구현하지 않고
  // 같은 paceRiskOf 하나가 두 창을 먹이도록 여기서 계산해 내보낸다.
  const fiveHourRisk = paceRiskOf(
    p.fiveHourPending ? null : p.fiveHourPct,
    p.fiveHourPacePct,
    fiveHour.projectedPct
  );
  const weeklyRisk = paceRiskOf(p.weeklyPct, p.weeklyPacePct, weekly.projectedPct);

  return {
    fiveHourRisk,
    weeklyRisk,
    fiveHourPct: p.fiveHourPct != null ? Math.round(p.fiveHourPct * 10) / 10 : null,
    fiveHourHasData: p.fiveHourHasData,
    fiveHourElapsed: formatHM(fiveHour.elapsedMs),
    fiveHourRemaining: formatHM(p.fiveHourResetInMs),
    fiveHourProjectedPct: fiveHour.projectedPct,
    fiveHourTimeToLimit: fiveHour.timeToLimitMs != null ? formatHM(fiveHour.timeToLimitMs) : null,
    fiveHourAtLimitNow: fiveHour.timeToLimitMs === 0,
    fiveHourSlowdownPct: slowdownPct(fiveHour.slowdownRatio),
    fiveHourModelBased: fiveHour.modelBased,
    weeklyPct: p.weeklyPct != null ? Math.round(p.weeklyPct * 10) / 10 : null,
    weeklyHasData: p.weeklyHasData,
    weeklyElapsed: formatHM(weekly.elapsedMs),
    weeklyRemaining: formatHM(p.weeklyResetInMs),
    weeklyProjectedPct: weekly.projectedPct,
    weeklyTimeToLimit: weekly.timeToLimitMs != null ? formatHM(weekly.timeToLimitMs) : null,
    weeklyAtLimitNow: weekly.timeToLimitMs === 0,
    weeklySlowdownPct: slowdownPct(weekly.slowdownRatio),
    weeklyModelBased: weekly.modelBased,
    // 두 한도 환산 (표본 부족이면 전부 null - 화면에서 해당 줄이 사라진다)
    weeklyHeadroomPct,
    weeklyWindowsLeft: weeklyWindowsLeft != null ? Math.round(weeklyWindowsLeft * 10) / 10 : null,
    weeklyWindowsPerDay,
    weeklyIfFiveHourFull,
    // 과거 구간들에서 모델 예측 vs 단순 선형 예측이 실제값 대비 평균적으로 얼마나 틀렸는지 (검증용, 없으면 null)
    fiveHourAccuracy: usageModel.getAccuracyStats('fiveHour'),
    weeklyAccuracy: usageModel.getAccuracyStats('weekly'),
  };
}

// 프롬프트 자체는 (모델이 지시를 가장 잘 따르는) 영어로 작성하고, "이 언어로 답하라"고만 지시한다.
// riskLevel은 언어와 무관한 영어 코드(safe/caution/danger)로만 받고, 화면에는 detail.js가 선택된
// 언어로 번역해서 보여준다 - 그래야 색상 판정 로직이 언어별 단어 매칭에 의존하지 않는다.
function buildAdvicePrompt(stats) {
  const languageName = LANGUAGE_NAME_EN[resolveLanguage()] || 'English';

  // 예전에는 "recommended remaining headroom" = 100 - 예상마감% 를 넘겼는데, 그건 "구간이 끝날 때
  // 남아 있을 여유분"이지 "앞으로 더 써도 되는 양"이 아니라서 화면과 조언이 함께 틀렸다. 이제는
  // 한도 도달까지 남은 시간과 줄여야 할 속도처럼 그대로 행동으로 옮길 수 있는 값만 넘긴다.
  const limitLine = (tag, hasData, pct, projectedPct, remaining, timeToLimit, atLimitNow, slowdownPct) => {
    if (!hasData) return `[${tag}] no real-time data (requires a Claude Code terminal session)`;
    const parts = [`current usage ${pct}%`, `${remaining} until this window resets`];
    if (projectedPct == null) {
      parts.push('too early in the window to project the end-of-window usage');
    } else if (atLimitNow) {
      parts.push('the limit has already been reached');
    } else if (timeToLimit != null) {
      parts.push(`projected to reach 100% in ${timeToLimit} - BEFORE the window resets`);
      parts.push(`slowing to ${slowdownPct}% of the current pace would make it last the whole window`);
    } else {
      parts.push(`projected to end the window at ${projectedPct}%, staying within the limit`);
    }
    return `[${tag}] ` + parts.join('; ');
  };

  const fiveHourLine = limitLine(
    '5-hour limit',
    stats.fiveHourHasData,
    stats.fiveHourPct,
    stats.fiveHourProjectedPct,
    stats.fiveHourRemaining,
    stats.fiveHourTimeToLimit,
    stats.fiveHourAtLimitNow,
    stats.fiveHourSlowdownPct
  );
  const weeklyLine = limitLine(
    'Weekly limit',
    stats.weeklyHasData,
    stats.weeklyPct,
    stats.weeklyProjectedPct,
    stats.weeklyRemaining,
    stats.weeklyTimeToLimit,
    stats.weeklyAtLimitNow,
    stats.weeklySlowdownPct
  );

  // 두 한도는 독립이 아니다 - 같은 사용이 둘을 동시에 깎는다. 그 연결을 모델에게 알려주지 않으면
  // 5시간과 주간에 대해 서로 모순되는 조언(예: "5시간 여유 있으니 계속" + "주간 아끼세요")을 낸다.
  const linkLines = [];
  if (stats.weeklyWindowsLeft != null) {
    linkLines.push(
      `[Link] The two limits share the same usage. The remaining weekly headroom (${stats.weeklyHeadroomPct}%) ` +
        `is worth about ${stats.weeklyWindowsLeft} more fully-used 5-hour windows` +
        (stats.weeklyWindowsPerDay != null ? `, i.e. about ${stats.weeklyWindowsPerDay} per day for the rest of the week` : '')
    );
  }
  if (stats.weeklyIfFiveHourFull != null) {
    linkLines.push(
      `[Link] Using the current 5-hour window all the way to 100% would put the weekly limit at ` +
        `${stats.weeklyIfFiveHourFull}%`
    );
  }

  return [
    'You are a Claude Code usage-pacing coach. The numbers below are already computed - do not recompute or change them.',
    `Write in ${languageName}.`,
    'The 5-hour and weekly limits are NOT independent: the same usage counts against both. Any [Link] lines below say how they relate - your two pieces of advice must be consistent with each other.',
    'When the weekly limit is the one in trouble, say so even if the 5-hour limit looks comfortable: slowing down inside this 5-hour window cannot fix a week-level overrun.',
    'The app already shows the user every number above the text you write, so do NOT restate them. Write what to DO instead.',
    'Each per-limit field must be exactly ONE short imperative sentence, at most 20 words, telling the user what to do right now (for example: keep going, wrap up the current task, switch to a lighter model, or save the heavy work for after the reset).',
    `For any limit marked as having no data, do not give advice for it - just briefly say (in ${languageName}) that there is no data.`,
    `Output ONLY one raw JSON object, no other text and no markdown code fences. Every text value (summary, fiveHour, weekly) must be written in ${languageName}. The "riskLevel" field is the only exception: it must be exactly one of these English codes, untranslated: "safe", "caution", or "danger".`,
    '{"summary": "one short sentence covering both limits", "riskLevel": "safe or caution or danger", ' +
      '"fiveHour": "one short imperative sentence for the 5-hour limit", ' +
      '"weekly": "one short imperative sentence for the weekly limit"}',
    '',
    fiveHourLine,
    weeklyLine,
    ...linkLines,
  ].join('\n');
}

const RISK_CODES = ['safe', 'caution', 'danger'];

// 모델이 JSON 앞뒤에 설명이나 ```코드블록을 덧붙이는 경우를 대비해 순수 JSON 부분만 추출한다.
function parseAdviceResponse(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (
      obj &&
      typeof obj.summary === 'string' &&
      typeof obj.riskLevel === 'string' &&
      typeof obj.fiveHour === 'string' &&
      typeof obj.weekly === 'string'
    ) {
      // 모델이 코드 대신 실제 언어로 적어버리는 경우를 대비한 방어적 기본값 (badge 색상 판정이 깨지지 않도록)
      const code = obj.riskLevel.trim().toLowerCase();
      obj.riskLevel = RISK_CODES.includes(code) ? code : 'caution';
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchUsageAdvice(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && adviceCache && now - adviceCache.computedAt < ADVICE_CACHE_MS) {
    return { advice: adviceCache.advice, structured: adviceCache.structured, stats: adviceCache.stats, cached: true };
  }

  const stats = computeAdviceStats();
  if (!stats.fiveHourHasData && !stats.weeklyHasData) {
    return { error: 'no_data', stats };
  }
  const prompt = buildAdvicePrompt(stats);

  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      if (res.status === 429) return { error: 'rate_limited', stats };
      return { error: 'http', status: res.status, message: errBody.message || errBody.error || '', stats };
    }

    const data = await res.json();
    const text = data.text;
    if (!text) {
      return { error: 'empty_response', stats };
    }

    const parsed = parseAdviceResponse(text);
    const advice = parsed || text;
    const structured = !!parsed;
    adviceCache = { advice, structured, stats, computedAt: now };
    return { advice, structured, stats, cached: false };
  } catch (err) {
    return { error: 'network', message: String((err && err.message) || err), stats };
  }
}

function openDetailWindow() {
  if (detailWindow && !detailWindow.isDestroyed()) {
    detailWindow.focus();
    return;
  }

  // 조언 카드마다 헤드라인 아래 보조 줄(남은 시간/줄여야 할 속도, 다른 한도와의 환산)이 붙으면서
  // 480으로는 주간 카드가 잘렸다. 내용이 가장 길 때(두 한도 모두 한도 도달 + 환산 줄 + 정확도 줄까지)
  // 760이면 스크롤 없이 들어간다.
  // 다만 세로 768 같은 화면에서는 700이 작업 영역을 넘으므로, 넘칠 때만 작업 영역에 맞춘다
  // (resizable:false라 사용자가 직접 줄일 수 없어서 창이 화면 밖으로 나가면 손쓸 방법이 없다).
  const { workArea } = screen.getPrimaryDisplay();
  detailWindow = new BrowserWindow({
    width: 420,
    height: Math.min(760, Math.max(420, workArea.height - 80)),
    useContentSize: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    alwaysOnTop: true,
    center: true,
    // parent를 mainWindow(focusable:false)로 두면 Windows에서 이 자식 창을 닫을 때 오너 창까지
    // 같이 닫혀버리는 문제가 있어서 일부러 독립 창으로 둔다.
    title: L('detailWindowTitle'),
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  detailWindow.setMenuBarVisibility(false);
  detailWindow.loadFile(path.join(__dirname, 'renderer', 'detail.html'));
  detailWindow.webContents.on('did-finish-load', () => sendLocale(detailWindow));

  detailWindow.on('closed', () => {
    detailWindow = null;
  });
}

// 위젯 헤더 배지에 쓸 한 줄 요약.
//   danger  = 이 속도면 초기화 전에 한도에 도달한다 (예상 마감 > 100%)
//   caution = 기준선을 넘어섰다 (남은 시간 대비 과소비 중)
//   safe    = 기준선 아래
// danger는 예측이 필요해서 구간 초반(데드존)에는 나오지 않지만 caution은 기준선만 있으면 되므로,
// 구간 초반에도 "빠르다"는 신호는 계속 나온다.
function paceRiskOf(pct, pacePct, projectedPct) {
  if (pct == null) return null;
  if (projectedPct != null && projectedPct > 100) return 'danger';
  if (pacePct != null && pct > pacePct) return 'caution';
  return 'safe';
}

const RISK_RANK = { safe: 0, caution: 1, danger: 2 };

// 두 한도 중 "먼저 막는 쪽"을 고르고 어느 쪽인지도 같이 돌려준다. 단순히 더 나쁜 코드만 고르면
// 두 방향이 대칭으로 보이는데, 실제 결과는 전혀 다르다.
//   - 5시간 초과 + 주간 여유 -> 최대 5시간 막혔다가 새 구간이 통째로 열린다. 게다가 5시간 여유분은
//     안 쓰면 소멸이라 다 쓰는 게 오히려 정상이다.
//   - 주간 초과 + 5시간 여유 -> 지금 속도를 줄여도 이번 구간 안에서는 해결되지 않는다. 며칠에 걸쳐
//     줄여야 한다.
// 그래서 심각도가 같으면 주간이 이긴다 - 결과가 길고 이번 세션 안에서 되돌릴 수 없기 때문이다.
function bindingRisk(fiveHourRisk, weeklyRisk) {
  const rank = (r) => (r == null ? -1 : RISK_RANK[r]);
  if (rank(weeklyRisk) >= rank(fiveHourRisk)) {
    return weeklyRisk == null ? null : { risk: weeklyRisk, limit: weeklyRisk === 'safe' ? null : 'weekly' };
  }
  return { risk: fiveHourRisk, limit: fiveHourRisk === 'safe' ? null : 'fiveHour' };
}

function pushUsageUpdate() {
  const percents = computePercents();
  checkUsageThresholds(percents);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 상태 표시는 예상 마감까지 봐야 하므로 예측을 같이 구한다. computeAdviceStats()를 쓰면
  // computePercents()가 한 번 더 돌면서 학습 샘플이 중복 기록되므로, 부수효과 없는 projectLimit()만 쓴다.
  const idleSec = currentIdleSec();
  const fiveHour = projectLimit(
    'fiveHour',
    FIVE_HOUR_MS,
    percents.fiveHourPct,
    percents.fiveHourResetInMs,
    percents.fiveHourPending ? 0 : costStore.getCostSince(currentFiveHourStartMs() / 1000),
    idleSec
  );
  const weekly = projectLimit(
    'weekly',
    WEEK_MS,
    percents.weeklyPct,
    percents.weeklyResetInMs,
    costStore.getCostSince(currentWeekStartMs() / 1000),
    idleSec
  );

  // 아직 시작하지 않은 5시간 구간은 pct가 0으로 채워져 있을 뿐 실제 신호가 아니라서 제외한다.
  const fiveHourRisk = paceRiskOf(
    percents.fiveHourPending ? null : percents.fiveHourPct,
    percents.fiveHourPacePct,
    fiveHour.projectedPct
  );
  const weeklyRisk = paceRiskOf(percents.weeklyPct, percents.weeklyPacePct, weekly.projectedPct);
  // 두 한도의 상태를 각 게이지 옆에 따로 보여주므로 "먼저 막는 쪽"은 더 이상 표시를 독점하지 않는다.
  // 다만 동률일 때(둘 다 주의/둘 다 위험) 어느 쪽을 먼저 봐야 하는지는 여전히 정보라서, 그 행의
  // 라벨만 밝게 하는 데 쓴다.
  const binding = bindingRisk(fiveHourRisk, weeklyRisk);

  mainWindow.webContents.send('usage-update', {
    ...percents,
    fiveHourRisk,
    weeklyRisk,
    bindingLimit: binding ? binding.limit : null,
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pushUsageUpdate, POLL_INTERVAL_MS);
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: L('menuRefresh'), click: () => pushUsageUpdate() },
    { label: L('menuSettings'), click: () => openCalibrateWindow() },
    ...updater.buildMenuItems(),
    { type: 'separator' },
    {
      label: L('menuAutostart'),
      type: 'checkbox',
      checked: !!cfg.autostart,
      click: (menuItem) => {
        const enabled = menuItem.checked;
        try {
          // path/args는 Windows 전용 옵션이다. macOS는 앱 번들 자체를 로그인 항목으로 등록하므로 openAtLogin만 넘긴다.
          app.setLoginItemSettings(
            process.platform === 'win32'
              ? { openAtLogin: enabled, path: process.execPath, args: [app.getAppPath()] }
              : { openAtLogin: enabled }
          );
          cfg.autostart = enabled;
          configStore.saveConfig(cfg);
        } catch {
          menuItem.checked = !enabled;
        }
      },
    },
    { type: 'separator' },
    { label: L('menuQuit'), click: () => quitApp() },
  ]);
}

function createMainWindow() {
  // workArea의 x/y까지 더해야 macOS 상단 메뉴 막대(또는 Windows에서 위/왼쪽에 둔 작업표시줄)만큼 어긋나지 않는다.
  const { workArea } = screen.getPrimaryDisplay();
  const x = cfg.windowX != null ? cfg.windowX : workArea.x + Math.round((workArea.width - WIDGET_WIDTH) / 2);
  const y = cfg.windowY != null ? cfg.windowY : workArea.y + workArea.height - WIDGET_HEIGHT - BOTTOM_MARGIN;

  mainWindow = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    useContentSize: true,
    x,
    y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#1f2126',
    opacity: getConfiguredOpacity(),
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // macOS: 데스크톱(Spaces)을 옮기거나 다른 앱을 전체 화면으로 띄워도 위젯이 계속 보이게 한다. Dock 아이콘은
  // Info.plist의 LSUIElement(개발 모드에선 app.dock.hide())로 이미 숨겨져 있으므로 프로세스 타입 전환은 건너뛴다 -
  // 전환하면 숨겨둔 Dock 아이콘이 다시 나타난다.
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => sendLocale(mainWindow));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    pushUsageUpdate();
  });

  mainWindow.on('moved', () => {
    const [wx, wy] = mainWindow.getPosition();
    cfg.windowX = wx;
    cfg.windowY = wy;
    configStore.saveConfig(cfg);
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    // focusable:false 상태에서는 팝업 메뉴가 바깥 클릭으로 닫히지 않으므로 메뉴가 떠 있는 동안만 활성화한다.
    mainWindow.setFocusable(true);
    buildContextMenu().popup({
      window: mainWindow,
      x: params.x,
      y: params.y,
      callback: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFocusable(false);
      },
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pollTimer) clearInterval(pollTimer);
  });

  startPolling();
}

// 사용량/초기화 시각은 이제 실측값으로만 채워지므로 손으로 보정할 게 없다. 이 창은 위젯 투명도만 조절한다.
function openCalibrateWindow() {
  if (calibrateWindow && !calibrateWindow.isDestroyed()) {
    calibrateWindow.focus();
    return;
  }

  const initial = {
    opacity: getConfiguredOpacity(),
    minOpacity: MIN_OPACITY,
    maxOpacity: MAX_OPACITY,
    lang: resolveLanguage(),
    languages: SUPPORTED_LANGUAGES,
    notificationsEnabled: cfg.notificationsEnabled !== false,
    autoUpdateEnabled: cfg.autoUpdateEnabled !== false,
  };
  const opacityBeforeEdit = getConfiguredOpacity();

  let settled = false;
  const win = new BrowserWindow({
    width: 360,
    height: 272,
    useContentSize: true, // width/height가 타이틀바 제외한 콘텐츠 영역 기준이 되도록
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    center: true,
    // parent/modal을 mainWindow(focusable:false)에 걸면 Windows에서 이 창을 닫을 때(OK/취소)
    // 오너 창까지 같이 닫혀버리는 문제가 있어서 일부러 독립 창으로 둔다. 어차피 mainWindow는
    // focusable:false라 modal로 막을 상호작용도 없었다.
    title: L('settingsWindowTitle'),
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  calibrateWindow = win;
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'calibrate.html'));

  win.webContents.on('did-finish-load', () => {
    sendLocale(win);
    win.webContents.send('calibrate-init', initial);
  });

  function previewOpacity(_event, value) {
    if (mainWindow && !mainWindow.isDestroyed() && typeof value === 'number' && !Number.isNaN(value)) {
      mainWindow.setOpacity(clamp(value, MIN_OPACITY, MAX_OPACITY));
    }
  }

  function finishSubmit(_event, data) {
    if (settled) return;
    settled = true;
    if (typeof data.opacity === 'number' && !Number.isNaN(data.opacity)) {
      cfg.windowOpacity = clamp(data.opacity, MIN_OPACITY, MAX_OPACITY);
    }
    cfg.notificationsEnabled = !!data.notificationsEnabled;
    cfg.autoUpdateEnabled = !!data.autoUpdateEnabled;
    configStore.saveConfig(cfg);
    win.close();
    if (mainWindow) mainWindow.setOpacity(getConfiguredOpacity());
  }

  function finishCancel() {
    if (settled) return;
    settled = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setOpacity(opacityBeforeEdit);
    win.close();
  }

  ipcMain.on('calibrate-opacity-preview', previewOpacity);
  ipcMain.once('calibrate-submit', finishSubmit);
  ipcMain.once('calibrate-cancel', finishCancel);

  win.on('closed', () => {
    ipcMain.removeListener('calibrate-opacity-preview', previewOpacity);
    ipcMain.removeListener('calibrate-submit', finishSubmit);
    ipcMain.removeListener('calibrate-cancel', finishCancel);
    calibrateWindow = null;
    if (!settled) {
      settled = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setOpacity(opacityBeforeEdit);
    }
  });
}

// 실측 주간 초기화 시각이 매주 몇 분씩 흔들리더라도 그때마다 학습을 버리지 않도록 두는 여유.
const WEEK_PHASE_TOLERANCE_MS = 60 * 60 * 1000;

// 과거 사용 기록으로 개인화 모델을 미리 학습시킨다. 주간 모델은 완료된 구간이 1주에 하나씩만
// 생겨서 실시간으로만 배우면 한 달이 지나야 쓸 만해지는데, costs.jsonl에는 보통 그보다 긴 기록이
// 이미 남아있다. 그래서 8일치 캐시가 아니라 원본 로그 전체(getHistoricalEvents)를 학습에 쓴다.
//
// 주간은 실제 초기화 시각(cfg.weekResetAt)을 알아야 실시간과 같은 격자로 구간을 자를 수 있다.
// 아직 모르는 동안에는 5시간만 먼저 하고 주간은 보류했다가, statusline 훅의 실측값으로
// weekResetAt이 채워지는 순간(syncResetTimesFromRealtime)에 다시 호출되어 학습한다.
//
// 같은 기록을 두 번 학습하면 표본 수만 부풀어 신뢰도가 과대평가되므로, 한도별 완료 여부를
// cfg.usageModelBackfill에 남겨 한 번씩만 실행한다. 모델 버전이 오르면(학습 방식 변경)
// usageModel이 기존 학습을 폐기하므로 백필도 새 버전 기준으로 다시 수행한다.
function backfillUsageModelIfNeeded() {
  const saved = cfg.usageModelBackfill;
  const done =
    saved && saved.version === usageModel.MODEL_VERSION
      ? { ...saved }
      : { version: usageModel.MODEL_VERSION, fiveHourAt: null, weeklyAt: null };

  const phase = usageModel.windowPhaseOf(cfg.weekResetAt, WEEK_MS);
  // 주간 초기화 시각이 7일의 배수가 아닌 만큼 바뀌면(수동 보정값 -> 실측값 교체 등) 격자 자체가
  // 달라진 것이라, 이전 위상으로 배운 곡선은 경과율 축이 어긋난다. 버리고 새 위상으로 다시 배운다.
  const phaseChanged =
    done.weeklyAt != null &&
    phase != null &&
    !usageModel.isSameWindowPhase(done.weeklyPhase, phase, WEEK_MS, WEEK_PHASE_TOLERANCE_MS);
  const needFiveHour = !done.fiveHourAt;
  const needWeekly = phase != null && (!done.weeklyAt || phaseChanged);
  if (!needFiveHour && !needWeekly) return;

  const events = costStore.getHistoricalEvents();
  // 로그가 아직 없거나 읽지 못한 경우 - 완료로 표시하지 않고 다음 기회(다음 실행/다음 실측값)에 재시도한다.
  if (events.length === 0) return;

  const nowSec = Date.now() / 1000;
  if (needFiveHour) {
    const n = usageModel.backfillFromEvents('fiveHour', FIVE_HOUR_MS / 1000, events, nowSec);
    done.fiveHourAt = Date.now();
    console.log(`[usageModel] 과거 기록 백필 - 5시간 구간 ${n}개 학습에 반영.`);
  }
  if (needWeekly) {
    if (phaseChanged) {
      usageModel.resetKind('weekly');
      console.log('[usageModel] 주간 초기화 시각의 위상이 바뀌어 기존 주간 학습을 폐기하고 다시 배운다.');
    }
    const n = usageModel.backfillFromEvents('weekly', WEEK_MS / 1000, events, nowSec, cfg.weekResetAt / 1000);
    done.weeklyAt = Date.now();
    done.weeklyPhase = phase;
    console.log(`[usageModel] 과거 기록 백필 - 주간 구간 ${n}개 학습에 반영 (초기화 시각 격자 기준).`);
  }

  cfg.usageModelBackfill = done;
  configStore.saveConfig(cfg);
}

// statusLine에 등록된 명령이 클로미터 것인지 판별하는 표식. 1.0.0은 `node "...statuslineBridge.js"`를,
// 지금 Windows 버전은 claumeter-statusline.cmd를 등록하므로 둘 다 우리 것으로 보고 새 명령으로 교체한다.
const STATUSLINE_MARKERS = ['statuslineBridge.js', 'claumeter-statusline.cmd'];

// 따옴표 없이 명령으로 써도 Git Bash와 PowerShell 양쪽에서 한 덩어리 경로로 해석되는 문자만 허용한다.
const SHELL_SAFE_PATH = /^[\p{L}\p{N}_.~/:+-]+$/u;

// Node.js 설치 없이 동작하도록 클로미터 실행 파일을 ELECTRON_RUN_AS_NODE=1로 띄워 브리지를 실행하는 명령을 만든다.
function buildStatusLineCommand() {
  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
  if (process.platform === 'win32') {
    return windowsStatusLineCommand(path.join(unpackedDir, 'claumeter-statusline.cmd'));
  }
  // macOS: Claude Code가 sh 계열 셸로 실행하므로 환경변수 접두어 문법을 그대로 쓸 수 있다.
  const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `ELECTRON_RUN_AS_NODE=1 ${shQuote(process.execPath)} ${shQuote(path.join(unpackedDir, 'statuslineBridge.js'))}`;
}

// Windows의 Claude Code는 statusLine 명령을 Git Bash가 있으면 Git Bash로, 없으면 PowerShell로 실행한다.
// 두 셸에서 모두 도는 형태는 "따옴표 없는 경로 하나"뿐이다 - PowerShell은 따옴표로 감싼 경로를 실행하지 않고
// 문자열로 출력만 하고, 환경변수 설정 문법은 두 셸이 서로 다르다. 그래서 환경변수는 .cmd 래퍼 안에서 켜고,
// 여기서는 래퍼 경로만 따옴표 없이 등록한다. 역슬래시는 Git Bash가 이스케이프로 먹어버리므로 슬래시로 바꾸고,
// 경로에 공백 등이 있으면 ~(홈 폴더) 표기나 8.3 짧은 경로로 피한다. 둘 다 안 되면 마지막 수단으로 따옴표를
// 씌운다(이 경우 Git Bash에서만 동작한다).
function windowsStatusLineCommand(wrapperPath) {
  const toSlashes = (p) => p.replace(/\\/g, '/');
  const home = os.homedir();
  const candidates = [
    () => wrapperPath,
    () => (wrapperPath.toLowerCase().startsWith(home.toLowerCase() + path.sep) ? '~' + wrapperPath.slice(home.length) : null),
    () => windowsShortPath(wrapperPath),
  ];
  for (const candidate of candidates) {
    const p = candidate();
    if (p && SHELL_SAFE_PATH.test(toSlashes(p))) return toSlashes(p);
  }
  return `"${toSlashes(wrapperPath)}"`;
}

// 공백이 들어간 경로(예: C:\Program Files\ClauMeter)의 8.3 짧은 이름을 cmd로 얻는다. 볼륨에서 짧은 이름이
// 꺼져 있으면 원래 경로가 그대로 나오므로 호출하는 쪽의 SHELL_SAFE_PATH 검사에서 걸러진다.
function windowsShortPath(p) {
  try {
    const out = execFileSync('cmd.exe', [`/d /s /c "for %I in ("${p}") do @echo %~sI"`], {
      windowsVerbatimArguments: true,
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

// Claude Code의 statusLine 훅 경로는 사용자명뿐 아니라 설치 위치(현재 사용자용/모든 사용자용/커스텀 경로)에
// 따라서도 달라지고, 이름 변경이나 재설치로도 바뀔 수 있다. 매번 손으로 등록/수정하게 두는 대신, 패키징된
// 설치본이 실행될 때마다 process.resourcesPath(이 설치본의 실제 경로)를 기준으로 ~/.claude/settings.json의
// statusLine을 자동으로 맞춰준다. 사용자가 이미 다른 용도로 statusLine을 쓰고 있으면(우리가 등록한 값이
// 아니면) 절대 덮어쓰지 않는다 - Claude Code는 statusLine을 하나만 지원하기 때문.
function ensureStatusLineHook() {
  if (!app.isPackaged) return;
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const expectedCommand = buildStatusLineCommand();

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      // 파일이 아직 없을 때만 새로 만든다. 내용이 깨져 있거나(주석, 쉼표 오류 등) 읽을 수 없는데 {}로 덮어쓰면
      // 사용자의 다른 Claude Code 설정이 전부 날아가므로, 그럴 때는 건드리지 않는다.
      if (err.code !== 'ENOENT') return;
    }

    const current = settings.statusLine;
    const isMissing = !current || typeof current.command !== 'string';
    const isOurs = !isMissing && STATUSLINE_MARKERS.some((marker) => current.command.includes(marker));

    if (!isMissing && !isOurs) return; // 사용자가 다른 용도로 쓰고 있음 - 건드리지 않음
    if (!isMissing && current.command === expectedCommand) return; // 이미 최신 상태

    settings.statusLine = { type: 'command', command: expectedCommand };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    sendUsageNotification(L('notifyStatusLineHookSet'));
  } catch {
    // 자동 등록에 실패해도 README의 수동 등록 안내로 대체할 수 있으니 조용히 넘어간다.
  }
}

ipcMain.on('open-detail-window', () => openDetailWindow());
ipcMain.on('open-calibrate-window', () => openCalibrateWindow());
// app.quit()은 창을 하나씩 정상적으로 닫아보는 방식인데, 그 과정에서 GPU/유틸리티 프로세스가
// 완전히 정리되지 않고 작업관리자에 좀비 프로세스로 남는 경우가 있어서 app.exit()으로 즉시
// 강제 종료한다. 설정은 바뀔 때마다 바로바로 저장되므로 종료 시 따로 정리할 미저장 데이터가 없다.
// 단, 자동 업데이트를 이미 내려받아 뒀다면 종료하는 김에 설치를 시작한다 (updater.js 참고).
function quitApp() {
  if (updater.installOnQuitIfReady()) return;
  app.exit(0);
}

ipcMain.on('quit-app', () => quitApp());
ipcMain.handle('get-usage-advice', (_event, opts) => fetchUsageAdvice(!!(opts && opts.forceRefresh)));

// 언어는 OK/취소 흐름과 별개로 선택 즉시 적용된다(투명도 미리보기와 달리 취소해도 되돌리지 않음) -
// 다른 나라 사용자가 드롭다운만 바꾸면 바로 모든 창에 반영되는 게 자연스럽기 때문.
ipcMain.on('set-language', (_event, code) => {
  if (!LOCALES[code]) return;
  cfg.language = code;
  configStore.saveConfig(cfg);
  broadcastLocale();
  pushUsageUpdate();
});

ipcMain.on('clickthrough:toggle', () => {
  clickThroughEnabled = !clickThroughEnabled;
  applyClickThroughState();
  broadcastClickThroughState();
});
ipcMain.handle('clickthrough:get-state', () => clickThroughEnabled);
ipcMain.on('clickthrough:hover', (_event, hovering) => {
  if (!clickThroughEnabled || !mainWindow || mainWindow.isDestroyed()) return;
  // 헤더 버튼 위에 있을 때만 실제로 클릭을 받게 하고, 벗어나면 다시 통과시킨다.
  mainWindow.setIgnoreMouseEvents(!hovering, { forward: true });
});

// macOS에서 다운로드 폴더나 DMG 안의 앱을 바로 실행하면, macOS가 앱을 임시 경로(App Translocation)로 옮겨서
// 실행한다. 그 경로를 statusLine 훅에 등록하면 앱을 닫는 순간 경로가 사라져 훅이 깨지므로, 응용 프로그램 폴더로
// 옮기도록 권하고 옮기기 전까지는 훅을 등록하지 않는다. 훅을 등록해도 되는 위치면 true를 돌려준다.
function ensureInApplicationsFolderOnMac() {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return true;
  app.focus({ steal: true }); // Dock 아이콘이 없는 앱이라 이렇게 해야 대화상자가 다른 창 뒤에 숨지 않는다
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: [L('moveToApplicationsButton'), L('moveToApplicationsLater')],
    defaultId: 0,
    cancelId: 1,
    message: L('moveToApplicationsMessage'),
    detail: L('moveToApplicationsDetail'),
  });
  if (choice === 0) {
    try {
      // 성공하면 앱이 응용 프로그램 폴더에서 자동으로 다시 실행되고 지금 프로세스는 종료된다.
      app.moveToApplicationsFolder();
    } catch {
      // 권한 문제 등으로 실패 - 이번 실행은 훅 등록 없이 위젯만 띄운다.
    }
  }
  return false;
}

// 초기화 시각은 더 이상 사용자가 손으로 입력할 필요가 없다 - statusline 훅이 실측값을 남기는 즉시
// computePercents()의 syncResetTimesFromRealtime()이 cfg를 실제 값으로 채운다. 그래서 최초 실행 때도
// 설정 창을 강제로 띄우지 않고 바로 위젯을 보여주며, 실측값이 아직 없으면 "데이터 없음"으로 표시된다.
// (설정 ⚙ 버튼으로 여전히 수동 보정은 가능하다.)
app.whenReady().then(() => {
  // 패키징된 앱은 Info.plist의 LSUIElement로 Dock 아이콘이 숨겨지고, 개발 모드(npm start)에서도 같게 보이도록 숨긴다.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  if (ensureInApplicationsFolderOnMac()) ensureStatusLineHook();
  backfillUsageModelIfNeeded();
  createMainWindow();
  updater.init({
    t: L,
    iconPath: ICON_PATH,
    isAutoCheckEnabled: () => cfg.autoUpdateEnabled !== false,
  });
});

app.on('window-all-closed', () => {
  quitApp();
});
