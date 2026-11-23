// Preview-only nutrition label scanner. The photo is processed in memory and never saved.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Nutrition scanner is not configured.' });
  const { image } = req.body || {};
  if (typeof image !== 'string' || image.length > 5500000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    return res.status(400).json({ error: 'Please upload a JPG, PNG or WebP label image (under 4 MB).' });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 23000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        temperature: 0, max_completion_tokens: 450,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Read only the visible Nutrition Facts panel. Return ONLY a JSON object with keys name, servingSize, calories, protein, carbs, fat, warning. Values for calories, protein, carbs, fat must be numbers per ONE labeled serving or null if unreadable. name and servingSize are strings; warning is a string. Never infer or guess missing values, and do not calculate from percentages. If no readable nutrition facts panel is visible, set calories to null and explain in warning. If food name is not visible use "Scanned food". Units: calories kcal; macros grams. Do not treat values per container as per serving.' },
          { role: 'user', content: [
            { type: 'text', text: 'Extract the nutrition values per serving from this photograph. Include a warning for ambiguous or missing fields.' },
            { type: 'image_url', image_url: { url: image } }
          ] }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('Label scan Groq error', response.status, data?.error?.message);
      return res.status(response.status === 429 ? 429 : 502).json({ error: response.status === 429 ? 'Scanner is busy or rate-limited. Please retry shortly.' : 'Could not read the label with the vision model. Please retry.' });
    }
    const raw = data?.choices?.[0]?.message?.content;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return res.status(502).json({ error: 'The scanner returned an unreadable result. Try another photo.' }); }
    const numeric = (value) => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
    const label = {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 100) : 'Scanned food',
      servingSize: typeof parsed.servingSize === 'string' ? parsed.servingSize.slice(0, 100) : '',
      calories: numeric(parsed.calories), protein: numeric(parsed.protein),
      carbs: numeric(parsed.carbs), fat: numeric(parsed.fat),
      warning: typeof parsed.warning === 'string' ? parsed.warning.slice(0, 300) : ''
    };
    if (label.calories === null) return res.status(422).json({ error: label.warning || 'Calories could not be read. Try a clearer photo.' });
    return res.status(200).json(label);
  } catch (err) {
    console.error('Label scanner failed', err.message);
    return res.status(err.name === 'AbortError' ? 504 : 502).json({ error: 'Label scan failed or timed out. Please try again.' });
  } finally { clearTimeout(timeout); }
}
