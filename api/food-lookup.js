// USDA FoodData Central lookup. Set USDA_API_KEY in Vercel Preview and Production.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const query = String(req.query?.q || '').trim();
  if (query.length < 3 || query.length > 120) return res.status(400).json({ error: 'Enter a food name.' });
  if (!process.env.USDA_API_KEY) return res.status(200).json({ available: false, result: null });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch('https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' + encodeURIComponent(process.env.USDA_API_KEY), {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, pageSize: 10, dataType: ['Foundation', 'SR Legacy'] })
    });
    if (!response.ok) return res.status(200).json({ available: true, result: null });
    const data = await response.json();
    const words = query.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(w => w.length > 2);
    const foods = (data.foods || []).filter(food => words.length && words.every(w => (food.description || '').toLowerCase().includes(w)));
    const food = foods.find(food => (food.foodNutrients || []).some(n => (n.nutrientId === 1008 || n.nutrientNumber === '208') && Number(n.value) > 0));
    if (!food) return res.status(200).json({ available: true, result: null });
    const nutrient = (id, number) => Number((food.foodNutrients || []).find(n => n.nutrientId === id || n.nutrientNumber === number)?.value || 0);
    return res.status(200).json({ available: true, result: {
      foodName: food.description, calories: Math.round(nutrient(1008, '208')),
      protein: Math.round(nutrient(1003, '203')), carbs: Math.round(nutrient(1005, '205')),
      fat: Math.round(nutrient(1004, '204')), servingGrams: 100,
      source: 'USDA FoodData Central (per 100 g)', fdcId: food.fdcId
    } });
  } catch (err) {
    console.warn('USDA lookup unavailable:', err.message);
    return res.status(200).json({ available: true, result: null });
  } finally { clearTimeout(timeout); }
}
