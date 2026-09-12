const { app, BrowserWindow, Menu, screen, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const costStore = require('./costStore');
const configStore = require('./configStore');
const usageModel = require('./usageModel');
const realtimeUsage = require('./realtimeUsage');
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

  return {
    fiveHourPct: fiveHourPending ? 0 : fiveHourRealPct,
    fiveHourHasData: fiveHourPending || fiveHourRealPct != null,
    fiveHourPending,
    weeklyPct: weeklyRealPct,
    weeklyHasData: weeklyRealPct != null,
    fiveHourResetInMs: !fiveHourPending
      ? realtime.fiveHour
        ? Math.max(0, realtime.fiveHour.resetsAt - Date.now())
        : cfg.fiveHourResetAt != null
          ? Math.max(0, cfg.fiveHourResetAt - Date.now())
          : null
      : null,
    weeklyResetInMs: realtime.weekly
      ? Math.max(0, realtime.weekly.resetsAt - Date.now())
      : cfg.weekResetAt != null
        ? Math.max(0, cfg.weekResetAt - Date.now())
        : null,
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

// 이번 구간 시작부터 지금까지의 페이스가 끝까지 이어진다고 가정했을 때 도달할 것으로 예상되는
// 사용률(%)을 추정한다. 개인화 모델이 충분히 학습되어 있으면(과거 구간의 경과율별 누적비용 곡선)
// 그 곡선 기반으로 예측하고, 아직 데이터가 부족하면 단순 선형 예측으로 대체(fallback)한다.
function computeAdviceStats() {
  const p = computePercents();

  const fiveHourElapsedMs =
    p.fiveHourResetInMs != null ? Math.max(0, FIVE_HOUR_MS - p.fiveHourResetInMs) : null;
  const weeklyElapsedMs = p.weeklyResetInMs != null ? Math.max(0, WEEK_MS - p.weeklyResetInMs) : null;

  const fiveHourCost = p.fiveHourPending ? 0 : costStore.getCostSince(currentFiveHourStartMs() / 1000);
  const weeklyCost = costStore.getCostSince(currentWeekStartMs() / 1000);

  // 유휴시간이 길면 이 구간의 사용이 사실상 끝난 것으로 보고 예측을 현재값 쪽으로 당긴다.
  // (곡선 모델만으로는 "이미 끝난 구간"을 표현할 수 없어 구조적으로 과대예측된다 - usageModel 참고.)
  const idleSec = currentIdleSec();

  const fiveHourModelPred =
    !p.fiveHourPending && fiveHourElapsedMs != null
      ? usageModel.predictFinalCost('fiveHour', fiveHourElapsedMs / FIVE_HOUR_MS, fiveHourCost, idleSec)
      : null;
  const weeklyModelPred =
    weeklyElapsedMs != null
      ? usageModel.predictFinalCost('weekly', weeklyElapsedMs / WEEK_MS, weeklyCost, idleSec)
      : null;

  // "페이스 배율" = 지금 페이스가 유지되면 최종적으로 지금의 몇 배가 될지. 비율이라 단위와 무관하므로
  // 실제 % (ground truth)에 그대로 곱해 "예상 마감 %"를 구한다. 현재 %가 실측값 없이 null이면
  // 곱할 기준값 자체가 없으므로 예측도 계산하지 않는다(추정치로 대체하지 않음).
  const fiveHourPaceMultiplier =
    fiveHourModelPred != null && fiveHourCost > 0 ? fiveHourModelPred / fiveHourCost : null;
  const weeklyPaceMultiplier = weeklyModelPred != null && weeklyCost > 0 ? weeklyModelPred / weeklyCost : null;

  // 구간 초반에는 모델이든 단순 폴백이든 예측이 의미 없는 수준이라 아예 내보내지 않는다
  // (usageModel.isProjectionReliable 참고). 주간 한도는 완료 구간이 하나뿐이라 같은 임계값을
  // 검증하지 못했지만, "구간의 1/4도 안 지난 시점의 외삽은 못 믿는다"는 근거는 구간 길이와 무관하다.
  const fiveHourElapsedFrac = fiveHourElapsedMs != null ? fiveHourElapsedMs / FIVE_HOUR_MS : null;
  const weeklyElapsedFrac = weeklyElapsedMs != null ? weeklyElapsedMs / WEEK_MS : null;

  let fiveHourProjectedPct = null;
  if (p.fiveHourPct != null && usageModel.isProjectionReliable(fiveHourElapsedFrac)) {
    const multiplier =
      fiveHourPaceMultiplier != null ? fiveHourPaceMultiplier : 1 / fiveHourElapsedFrac;
    fiveHourProjectedPct = Math.round(p.fiveHourPct * multiplier * 10) / 10;
  }

  let weeklyProjectedPct = null;
  if (p.weeklyPct != null && usageModel.isProjectionReliable(weeklyElapsedFrac)) {
    const multiplier = weeklyPaceMultiplier != null ? weeklyPaceMultiplier : 1 / weeklyElapsedFrac;
    weeklyProjectedPct = Math.round(p.weeklyPct * multiplier * 10) / 10;
  }

  return {
    fiveHourPct: p.fiveHourPct != null ? Math.round(p.fiveHourPct * 10) / 10 : null,
    fiveHourHasData: p.fiveHourHasData,
    fiveHourElapsed: formatHM(fiveHourElapsedMs),
    fiveHourRemaining: formatHM(p.fiveHourResetInMs),
    fiveHourProjectedPct,
    fiveHourSafePct: fiveHourProjectedPct != null ? Math.round((100 - fiveHourProjectedPct) * 10) / 10 : null,
    fiveHourModelBased: fiveHourModelPred != null,
    weeklyPct: p.weeklyPct != null ? Math.round(p.weeklyPct * 10) / 10 : null,
    weeklyHasData: p.weeklyHasData,
    weeklyElapsed: formatHM(weeklyElapsedMs),
    weeklyRemaining: formatHM(p.weeklyResetInMs),
    weeklyProjectedPct,
    weeklySafePct: weeklyProjectedPct != null ? Math.round((100 - weeklyProjectedPct) * 10) / 10 : null,
    weeklyModelBased: weeklyModelPred != null,
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

  const fiveHourLine = stats.fiveHourHasData
    ? `[5-hour limit] current usage ${stats.fiveHourPct}%, projected end-of-window usage at this pace ` +
      `${stats.fiveHourProjectedPct != null ? stats.fiveHourProjectedPct + '%' : 'not computable'}, ` +
      `recommended remaining headroom ${stats.fiveHourSafePct != null ? stats.fiveHourSafePct + '%' : 'not computable'}`
    : '[5-hour limit] no real-time data (requires a Claude Code terminal session)';
  const weeklyLine = stats.weeklyHasData
    ? `[Weekly limit] current usage ${stats.weeklyPct}%, projected end-of-window usage at this pace ` +
      `${stats.weeklyProjectedPct != null ? stats.weeklyProjectedPct + '%' : 'not computable'}, ` +
      `recommended remaining headroom ${stats.weeklySafePct != null ? stats.weeklySafePct + '%' : 'not computable'}`
    : '[Weekly limit] no real-time data (requires a Claude Code terminal session)';

  return [
    'You are a Claude Code usage-pacing coach. The numbers below are already computed - do not recompute or change them.',
    `Using these numbers, explain in ${languageName} how the user can use both the 5-hour and weekly limits effectively without exceeding them.`,
    'Do not mention elapsed or remaining time. Just quote the given "recommended remaining headroom" figures as-is inside your explanation.',
    `For any limit marked as having no data, do not give advice for it - just briefly say (in ${languageName}) that there is no data.`,
    `Output ONLY one raw JSON object, no other text and no markdown code fences. Every text value (summary, fiveHour, weekly) must be written in ${languageName}. The "riskLevel" field is the only exception: it must be exactly one of these English codes, untranslated: "safe", "caution", or "danger".`,
    '{"summary": "one-sentence overall summary", "riskLevel": "safe or caution or danger", ' +
      '"fiveHour": "1-2 sentence advice for the 5-hour limit (quoting the given recommended headroom)", ' +
      '"weekly": "1-2 sentence advice for the weekly limit (quoting the given recommended headroom)"}',
    '',
    fiveHourLine,
    weeklyLine,
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

  detailWindow = new BrowserWindow({
    width: 420,
    height: 480,
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

function pushUsageUpdate() {
  const percents = computePercents();
  checkUsageThresholds(percents);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('usage-update', percents);
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
