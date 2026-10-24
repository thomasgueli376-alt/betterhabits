export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY in Vercel settings' });
  }

  const { systemInstruction, userPrompt } = req.body;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemInstruction ? systemInstruction + '\n\n' : ''}${userPrompt}` }]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 600,
            responseMimeType: 'application/json',
            thinkingConfig: {
              thinkingLevel: 'low'
            }
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Error calling AI' });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
