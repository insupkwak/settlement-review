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
정산서 1행과 해당 증빙 PDF 텍스트를 비교해, 금액 일치 여부와 그 근거를 판정합니다.

[핵심 규칙]
1. 정산서 비교 기준 금액: LOCAL 비용(P열)이 있으면 LOCAL, 없으면 DEBIT(E열).
2. 증빙 PDF에 "Total"이 정산서와 달라도, 관리사가 일부만 전표화한 경우 PDF에 표시(체크/하이라이트/필기/태그/원/박스/별표 등)된 부분 금액이 우선. 그 표시가 있으면 is_partial=true.
3. **유사·근사 매칭을 적극 활용**: 금액이 소수점·통화 단위·반올림 차이로 살짝 다르면 WARN, 사실상 동일하면 OK. 인보이스 번호도 표기 차이(공백/하이픈/대소문자)는 동일로 본다.
4. 통화 코드(USD/KRW/EUR 등)가 다르면 무조건 MISMATCH로 처리하고 note에 "통화 불일치" 명시.
5. 판정 임계값:
   - OK: 금액 정확 일치 또는 1% 이내 차이
   - WARN: 1~5% 차이
   - MISMATCH: 5% 초과 차이 OR 통화 불일치 OR 금액 추출 불가
   - MISSING: PDF 텍스트가 사실상 비어있어 판단 불가(스캔본 등)

[note 작성 규칙 — 매우 중요]
note는 1~3문장으로 **불일치의 정확한 원인**을 구체적으로 설명한다. 단순히 "불일치"라고만 쓰지 말 것.
좋은 예:
- "정산서 USD 1,234.56 vs 증빙 Total USD 1,500.00, 차액 USD 265.44. 부분 전표 표시 없음."
- "통화 불일치: 정산서 KRW 1,500,000 / 증빙은 USD 1,200.00 표기."
- "증빙에 인보이스 번호 명시 없음. 벤더명·날짜로 매칭했으나 금액 USD 850 vs 정산서 USD 1,000, 15% 차이."
- "PDF에 'PARTIAL' 표시와 USD 500 수기 메모가 있어 부분 전표로 인식, 정산서 금액과 일치."
- "PDF 텍스트가 비어있음(스캔본 추정), 금액 자동 추출 불가."

반드시 다음 JSON 스키마로만 응답:
{
  "verdict": "OK"|"WARN"|"MISMATCH"|"MISSING",
  "pdf_amount": number|null,
  "pdf_currency": string|null,
  "is_partial": boolean,
  "diff_percent": number|null,
  "mismatch_reason": "AMOUNT_DIFF"|"CURRENCY_DIFF"|"NO_AMOUNT_FOUND"|"PARTIAL_OK"|"NONE",
  "note": "한국어 1~3문장, 구체적 수치 포함"
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
