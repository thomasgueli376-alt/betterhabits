// Groq-backed structured AI endpoint. The legacy URL remains /api/gemini for frontend compatibility.
// GROQ_API_KEY is only read server-side. No Google Gemini request is made.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'Groq AI is not configured (GROQ_API_KEY missing).' });
  }
  const { systemInstruction, userPrompt } = req.body || {};
  if (typeof userPrompt !== 'string' || !userPrompt.trim() || userPrompt.length > 12000 ||
      (systemInstruction != null && (typeof systemInstruction !== 'string' || systemInstruction.length > 12000))) {
    return res.status(400).json({ error: 'Invalid AI request.' });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.2,
        max_completion_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [
          ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
          { role: 'user', content: userPrompt }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || 'Groq AI request failed';
      console.warn('Groq request failed', response.status, message);
      return res.status(response.status).json({ error: message });
    }
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== 'string') {
      return res.status(502).json({ error: 'Groq returned no usable answer.' });
    }
    let parsed;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
    catch (err) {
      console.error('Groq invalid JSON', err.message);
      return res.status(502).json({ error: 'Groq returned invalid JSON. Please try again.' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return res.status(502).json({ error: 'Groq returned an unexpected response.' });
    }
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Groq proxy error', err.message);
    return res.status(err.name === 'AbortError' ? 504 : 502).json({
      error: err.name === 'AbortError' ? 'Groq AI took too long to respond.' : 'Unable to reach Groq AI.'
    });
  } finally { clearTimeout(timeout); }
}
