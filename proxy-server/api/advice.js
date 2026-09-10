// 클로미터(ClauMeter) 앱이 Groq를 직접 호출하지 않고 이 서버를 거치게 하는 프록시.
// 목적: Groq API 키를 앱(클라이언트) 바이너리 안에 절대 넣지 않는다 - Electron 앱은 asar만
// 풀면 소스가 그대로 보이므로, 키를 앱에 심으면 누구나 꺼내서 이 서비스와 무관한 용도로 쓸 수 있다.
// 이 파일은 Vercel Serverless Function으로 배포된다 (api/advice.js -> POST /api/advice).
//
// 모델/온도/토큰 한도는 전부 서버에서 고정한다 - 클라이언트가 보낸 값은 절대 신뢰하지 않는다.
// (그렇지 않으면 누구나 max_tokens를 키워서 비용을 부풀릴 수 있다.)

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-20b';
const MAX_TOKENS = 700;
const TEMPERATURE = 0.4;
const MAX_PROMPT_CHARS = 4000; // 정상적인 조언 프롬프트는 이보다 훨씬 짧다 - 이상 요청 방지용 상한선

// 간단한 요청 제한 (선택) - Upstash Redis 환경변수가 설정된 경우에만 켜진다.
// 설정 안 하면 제한 없이 그냥 통과한다(개발/저사용량 단계에서는 없어도 무방).
let ratelimit = null;
async function getRatelimiter() {
  if (ratelimit !== null) return ratelimit;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    ratelimit = false;
    return ratelimit;
  }
  try {
    const { Ratelimit } = require('@upstash/ratelimit');
    const { Redis } = require('@upstash/redis');
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(20, '1 h'), // IP당 시간에 20회
    });
  } catch {
    // 패키지가 아직 설치되지 않았으면 조용히 비활성화
    ratelimit = false;
  }
  return ratelimit;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    res.status(500).json({ error: 'server_misconfigured', message: 'GROQ_API_KEY is not set on the server.' });
    return;
  }

  const prompt = req.body && req.body.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'bad_request', message: 'prompt is required' });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(413).json({ error: 'prompt_too_long' });
    return;
  }

  const limiter = await getRatelimiter();
  if (limiter) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const { success } = await limiter.limit(ip);
    if (!success) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
  }

  try {
    const groqRes = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        reasoning_effort: 'low',
      }),
    });

    if (!groqRes.ok) {
      const text = await groqRes.text().catch(() => '');
      res.status(groqRes.status).json({ error: 'upstream_error', message: text.slice(0, 300) });
      return;
    }

    const data = await groqRes.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) {
      res.status(502).json({ error: 'empty_response' });
      return;
    }
    res.status(200).json({ text });
  } catch (err) {
    res.status(502).json({ error: 'network_error', message: String((err && err.message) || err) });
  }
};
