// PDF 텍스트 → 청구서 구조화 데이터 추출
// POST { pdfText, filename } → { invoice_numbers, vendor_names, amounts:[{value,currency,label,is_marked}], dates, notes }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 미설정' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { pdfText, filename } = body || {};
  if (!pdfText || !pdfText.trim()) {
    return res.json({
      invoice_numbers: [], vendor_names: [], amounts: [], dates: [],
      notes: 'PDF 텍스트가 비어있음 (스캔본 추정)',
      empty: true
    });
  }

  const sys = `당신은 청구서/세금계산서/영수증 PDF 텍스트에서 핵심 정보를 구조화 추출하는 어시스턴트입니다.

규칙:
1. 인보이스 번호(Invoice No., Bill No., 청구서번호, 세금계산서 일련번호 등)는 가능한 모든 후보를 배열로.
2. 벤더(공급자/Vendor/Supplier/Issuer) 이름도 회사명·약칭·영문/한글 등 여러 형태를 배열로.
3. **금액은 PDF에 등장하는 모든 의미있는 숫자**를 라벨과 함께 추출 (Total, Subtotal, Tax, Net, Amount Due, 합계, 공급가액, 세액, 등).
4. 관리사가 일부만 전표화한 경우 PDF에 표시(체크/하이라이트/원/별표/필기/PARTIAL/일부 등) 흔적이 텍스트에 남아있을 수 있음. 그 금액은 is_marked=true.
5. 통화는 USD/KRW/EUR/JPY/CNY 등 3자 코드로. 단위가 ₩,$,¥ 등이면 추정.
6. 모든 필드는 알 수 없으면 빈 배열/문자열로.

반드시 다음 JSON 스키마로만 응답:
{
  "invoice_numbers": [string],
  "vendor_names": [string],
  "amounts": [{"value": number, "currency": string|null, "label": string, "is_marked": boolean}],
  "dates": [string],
  "notes": string
}`;

  const user = `[PDF 파일명]
${filename || '(unknown)'}

[PDF 텍스트]
${String(pdfText).slice(0, 18000)}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { response_mime_type: 'application/json', temperature: 0 }
      })
    });
    if (!resp.ok) {
      const t = await resp.text();
      return res.status(502).json({ error: 'Gemini 오류: ' + resp.status, detail: t.slice(0,400) });
    }
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ invoice_numbers: [], vendor_names: [], amounts: [], dates: [], notes: 'AI 파싱 실패' });
    try { return res.json(JSON.parse(m[0])); }
    catch { return res.json({ invoice_numbers: [], vendor_names: [], amounts: [], dates: [], notes: 'AI JSON 오류' }); }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
