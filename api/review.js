// 정산서 1행 + 증빙 PDF 텍스트를 받아 Gemini로 판정
// POST body: { row: {...}, pdfText: "..." }
// 응답: { verdict, pdf_amount, pdf_currency, is_partial, note }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { row, pdfText } = body || {};
  if (!row) return res.status(400).json({ error: 'row 누락' });

  const sys = `당신은 선주사 회계감독을 돕는 정산 검토 어시스턴트입니다.
정산서 1행의 정보와 해당 증빙 PDF의 텍스트를 비교해, 금액 일치 여부를 판정합니다.

규칙:
- 증빙의 "Total" 금액이 정산서와 다를 수 있음. 관리사가 일부만 전표화한 경우 PDF에 표시(체크/하이라이트/필기/태그/주석 등)가 있을 수 있음. 그 표시 금액이 우선.
- 통화(currency)도 함께 확인.
- "OK"는 금액이 정확히 일치(또는 명시된 부분 금액과 일치)할 때만.
- 차이가 5% 이내면 "WARN", 그 외 불일치는 "MISMATCH", 증빙을 찾지 못했거나 텍스트가 비어있으면 "MISSING".

반드시 다음 JSON 스키마로만 응답:
{
  "verdict": "OK"|"WARN"|"MISMATCH"|"MISSING",
  "pdf_amount": number|null,
  "pdf_currency": string|null,
  "is_partial": boolean,
  "note": "한국어 1~2문장 요약"
}`;

  const user = `[정산서 1행]
- INVOICE NO.: ${row.invoice || '(없음)'}
- VENDOR NAME: ${row.vendor || '(없음)'}
- DEBIT: ${row.debit ?? '(없음)'}
- CURRENCY: ${row.currency || '(없음)'}
- LOCAL 비용: ${row.localAmt ?? '(없음)'}

[증빙 PDF 텍스트]
${pdfText ? String(pdfText).slice(0, 12000) : '(증빙 없음 또는 텍스트 추출 실패)'}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
      })
    });
    if (!resp.ok) {
      const t = await resp.text();
      return res.status(502).json({ error: 'Gemini API 오류: ' + resp.status, detail: t.slice(0, 400) });
    }
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ verdict: 'MISMATCH', pdf_amount: null, pdf_currency: null, is_partial: false, note: 'AI 응답 파싱 실패' });
    try { return res.json(JSON.parse(m[0])); }
    catch { return res.json({ verdict: 'MISMATCH', pdf_amount: null, pdf_currency: null, is_partial: false, note: 'AI 응답 JSON 오류' }); }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
