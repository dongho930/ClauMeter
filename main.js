const { app, BrowserWindow, Menu, screen, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const costStore = require('./costStore');
const configStore = require('./configStore');
const usageModel = require('./usageModel');
const realtimeUsage = require('./realtimeUsage');
const { LOCALES, SUPPORTED_LANGUAGES, LANGUAGE_NAME_EN, DEFAULT_LANGUAGE, t } = require('./locales');

// 일부 환경(하드웨어 가속/샌드박스 제한)에서 GPU 프로세스가 죽는 문제를 피하기 위한 안전장치
app.disableHardwareAcceleration();

// Windows 토스트 알림에 "Electron" 대신 이 앱의 이름/아이콘이 뜨도록 등록한다 (package.json의 appId와 동일해야 함).
app.setAppUserModelId('com.claumeter.app');

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
  if (changed) configStore.saveConfig(cfg);
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
  if (!fiveHourPending) {
    usageModel.recordSample(
      'fiveHour',
      (Date.now() - currentFiveHourStartMs()) / FIVE_HOUR_MS,
      fiveHourCost
    );
  }
  usageModel.recordSample('weekly', (Date.now() - currentWeekStartMs()) / WEEK_MS, weeklyCost);

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

  const fiveHourModelPred =
    !p.fiveHourPending && fiveHourElapsedMs != null
      ? usageModel.predictFinalCost('fiveHour', fiveHourElapsedMs / FIVE_HOUR_MS, fiveHourCost)
      : null;
  const weeklyModelPred =
    weeklyElapsedMs != null ? usageModel.predictFinalCost('weekly', weeklyElapsedMs / WEEK_MS, weeklyCost) : null;

  // "페이스 배율" = 지금 페이스가 유지되면 최종적으로 지금의 몇 배가 될지. 비율이라 단위와 무관하므로
  // 실제 % (ground truth)에 그대로 곱해 "예상 마감 %"를 구한다. 현재 %가 실측값 없이 null이면
  // 곱할 기준값 자체가 없으므로 예측도 계산하지 않는다(추정치로 대체하지 않음).
  const fiveHourPaceMultiplier =
    fiveHourModelPred != null && fiveHourCost > 0 ? fiveHourModelPred / fiveHourCost : null;
  const weeklyPaceMultiplier = weeklyModelPred != null && weeklyCost > 0 ? weeklyModelPred / weeklyCost : null;

  let fiveHourProjectedPct = null;
  if (p.fiveHourPct != null) {
    const multiplier =
      fiveHourPaceMultiplier != null
        ? fiveHourPaceMultiplier
        : fiveHourElapsedMs && fiveHourElapsedMs > 0
          ? FIVE_HOUR_MS / fiveHourElapsedMs
          : null;
    fiveHourProjectedPct = multiplier != null ? Math.round(p.fiveHourPct * multiplier * 10) / 10 : null;
  }

  let weeklyProjectedPct = null;
  if (p.weeklyPct != null) {
    const multiplier =
      weeklyPaceMultiplier != null
        ? weeklyPaceMultiplier
        : weeklyElapsedMs && weeklyElapsedMs > 0
          ? WEEK_MS / weeklyElapsedMs
          : null;
    weeklyProjectedPct = multiplier != null ? Math.round(p.weeklyPct * multiplier * 10) / 10 : null;
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
    { type: 'separator' },
    {
      label: L('menuAutostart'),
      type: 'checkbox',
      checked: !!cfg.autostart,
      click: (menuItem) => {
        const enabled = menuItem.checked;
        try {
          app.setLoginItemSettings({
            openAtLogin: enabled,
            path: process.execPath,
            args: [app.getAppPath()],
          });
          cfg.autostart = enabled;
          configStore.saveConfig(cfg);
        } catch {
          menuItem.checked = !enabled;
        }
      },
    },
    { type: 'separator' },
    { label: L('menuQuit'), click: () => app.exit(0) },
  ]);
}

function createMainWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primary.workAreaSize;
  const x = cfg.windowX != null ? cfg.windowX : Math.round((screenW - WIDGET_WIDTH) / 2);
  const y = cfg.windowY != null ? cfg.windowY : screenH - WIDGET_HEIGHT - BOTTOM_MARGIN;

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
  };
  const opacityBeforeEdit = getConfiguredOpacity();

  let settled = false;
  const win = new BrowserWindow({
    width: 360,
    height: 240,
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

// 앱을 처음 켰을 때 딱 한 번, costStore 캐시에 남아있는 과거 사용 기록(최대 8일치)으로
// 개인화 모델을 미리 학습시킨다. 이게 없으면 5시간 한도는 최소 3구간(길게는 며칠), 주간 한도는
// 최소 3주를 실시간으로 기다려야 모델이 쓰이기 시작하는데, 이미 캐시에 있는 기록만으로도
// 상당 부분을 즉시 메꿀 수 있다. 재실행할 때마다 같은 과거 데이터를 중복 학습하지 않도록
// cfg.usageModelBackfilledAt으로 한 번만 실행되게 막는다.
function backfillUsageModelIfNeeded() {
  if (cfg.usageModelBackfilledAt) return;
  costStore.scanAndUpdate();
  const nowSec = Date.now() / 1000;
  const events = costStore.getAllEvents();
  const fiveHourWindows = usageModel.backfillFromEvents('fiveHour', FIVE_HOUR_MS / 1000, events, nowSec);
  const weeklyWindows = usageModel.backfillFromEvents('weekly', WEEK_MS / 1000, events, nowSec);
  cfg.usageModelBackfilledAt = Date.now();
  configStore.saveConfig(cfg);
  console.log(
    `[usageModel] 과거 기록으로 백필 완료 - 5시간 구간 ${fiveHourWindows}개, 주간 구간 ${weeklyWindows}개 학습에 반영.`
  );
}

const STATUSLINE_MARKER = 'statuslineBridge.js';

// Claude Code의 statusLine 훅 경로는 사용자명뿐 아니라 설치 위치(현재 사용자용/모든 사용자용/커스텀 경로)에
// 따라서도 달라지고, 이름 변경이나 재설치로도 바뀔 수 있다. 매번 손으로 등록/수정하게 두는 대신, 패키징된
// 설치본이 실행될 때마다 process.resourcesPath(이 설치본의 실제 경로)를 기준으로 ~/.claude/settings.json의
// statusLine을 자동으로 맞춰준다. 사용자가 이미 다른 용도로 statusLine을 쓰고 있으면(우리가 등록한 값이
// 아니면) 절대 덮어쓰지 않는다 - Claude Code는 statusLine을 하나만 지원하기 때문.
function ensureStatusLineHook() {
  if (!app.isPackaged) return;
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const bridgePath = path.join(process.resourcesPath, 'app.asar.unpacked', 'statuslineBridge.js');
    const expectedCommand = `node "${bridgePath}"`;

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }

    const current = settings.statusLine;
    const isMissing = !current || typeof current.command !== 'string';
    const isOurs = !isMissing && current.command.includes(STATUSLINE_MARKER);

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
ipcMain.on('quit-app', () => app.exit(0));
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

// 초기화 시각은 더 이상 사용자가 손으로 입력할 필요가 없다 - statusline 훅이 실측값을 남기는 즉시
// computePercents()의 syncResetTimesFromRealtime()이 cfg를 실제 값으로 채운다. 그래서 최초 실행 때도
// 설정 창을 강제로 띄우지 않고 바로 위젯을 보여주며, 실측값이 아직 없으면 "데이터 없음"으로 표시된다.
// (설정 ⚙ 버튼으로 여전히 수동 보정은 가능하다.)
app.whenReady().then(() => {
  ensureStatusLineHook();
  backfillUsageModelIfNeeded();
  createMainWindow();
});

app.on('window-all-closed', () => {
  app.exit(0);
});
