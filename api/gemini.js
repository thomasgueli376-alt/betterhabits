// Server-side Gemini proxy. Keep GEMINI_API_KEY in Vercel environment variables only.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Gemini is not configured on the server (GEMINI_API_KEY missing).' });
  }
  const { systemInstruction, userPrompt } = req.body || {};
  if (typeof userPrompt !== 'string' || !userPrompt.trim() || userPrompt.length > 12000 ||
      (systemInstruction != null && (typeof systemInstruction !== 'string' || systemInstruction.length > 12000))) {
    return res.status(400).json({ error: 'Invalid AI request.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 24000);
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 2200,
          thinkingConfig: { thinkingLevel: 'LOW' }
        }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || 'Gemini request failed';
      console.error('Gemini API failure', response.status, message);
      return res.status(response.status).json({ error: message });
    }
    const raw = (data?.candidates?.[0]?.content?.parts || [])
      .filter(part => typeof part.text === 'string').map(part => part.text).join('');
    if (!raw) {
      console.error('Gemini returned no text', data?.candidates?.[0]?.finishReason || 'unknown');
      return res.status(502).json({ error: 'Gemini returned no usable response. Please try again.' });
    }
    let parsed;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
    catch (err) {
      console.error('Gemini invalid JSON', err.message);
      return res.status(502).json({ error: 'Gemini returned an invalid response. Please try again.' });
    }
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Gemini proxy error', err.message);
    return res.status(err.name === 'AbortError' ? 504 : 502).json({
      error: err.name === 'AbortError' ? 'Gemini took too long to respond. Please try again.' : 'Could not reach Gemini. Please try again.'
    });
  } finally {
    clearTimeout(timeout);
  }
}
