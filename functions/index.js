// 수풀AI Firebase Functions — Claude API 서버 프록시 (API 키 브라우저 노출 방지)
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.firestore();

// CORS: GitHub Pages 도메인만 허용
const corsHandler = cors({
  origin: [
    'https://jinwooshoon-coder.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
});

// ── 일일 사용 한도 ──────────────────────────────
const DAILY_LIMIT_STUDENT = 20;  // 학생 1인당 하루 최대 20회
const DAILY_LIMIT_TEACHER = 100; // 선생님 하루 최대 100회

// ── Claude 클라이언트 (API 키는 환경변수에서만) ─
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY
    || (functions.config().anthropic && functions.config().anthropic.key);
  if (!apiKey) throw new Error('서버 API 키 미설정 — Firebase 환경변수를 확인하세요');
  return new Anthropic({ apiKey });
}

// ── 학급 코드 검증 ──────────────────────────────
async function verifyClassCode(classCode) {
  if (!classCode) return false;
  try {
    const snap = await db.doc('config/settings').get();
    if (!snap.exists) return false;
    return snap.data().classCode === classCode;
  } catch (e) {
    console.error('학급 코드 검증 오류:', e);
    return false;
  }
}

// ── 일일 사용량 확인 및 차감 (트랜잭션) ──────────
async function checkAndDecrementUsage(studentName, isTeacher) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const safeKey = (studentName || '_teacher').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  const usageRef = db.doc(`usage/${today}/users/${safeKey}`);
  const limit = isTeacher ? DAILY_LIMIT_TEACHER : DAILY_LIMIT_STUDENT;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data().count || 0) : 0;

    if (current >= limit) {
      const role = isTeacher ? '선생님' : '학생';
      throw new Error(
        `오늘 사용 한도(${limit}회)를 다 썼어요. 내일 다시 도전해봐요! 🌙`
      );
    }

    tx.set(usageRef, {
      count: current + 1,
      isTeacher: !!isTeacher,
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { count: current + 1, remaining: limit - current - 1 };
  });
}

// ── 사용 로그 기록 ──────────────────────────────
async function saveLog({ classCode, studentName, isTeacher, grade, problem, htype, model, usage }) {
  try {
    await db.collection('logs').add({
      classCode: classCode || null,
      studentName: studentName || null,
      isTeacher: !!isTeacher,
      grade: grade || null,
      problem: problem ? String(problem).slice(0, 100) : null,
      htype: htype || null,
      model: model || 'claude-opus-4-6',
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      savedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    // 로그 실패는 무시 (응답에는 영향 없음)
    console.warn('로그 저장 실패:', e.message);
  }
}

// ══════════════════════════════════════════════════
// 메인 함수: callClaudeAPI
// 브라우저 → 이 함수 → Claude API (API 키는 여기서만)
// ══════════════════════════════════════════════════
exports.callClaudeAPI = functions
  .region('asia-northeast3') // 서울 리전 (한국 지연 최소화)
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') {
        return res.status(405).json({ error: '허용되지 않는 방법' });
      }

      const {
        classCode,
        studentName,
        isTeacher,
        grade,
        problem,
        htype,
        systemPrompt,
        userContent,
        model,
        maxTokens
      } = req.body;

      // 1. 학급 코드 검증
      const valid = await verifyClassCode(classCode);
      if (!valid) {
        return res.status(403).json({
          error: '학급 코드가 올바르지 않아요. 선생님께 코드를 다시 받으세요 🔒'
        });
      }

      // 2. 일일 사용량 확인
      let usageInfo;
      try {
        usageInfo = await checkAndDecrementUsage(studentName, isTeacher);
      } catch (e) {
        return res.status(429).json({ error: e.message });
      }

      // 3. Claude API 호출
      try {
        const client = getClient();
        const response = await client.messages.create({
          model: model || 'claude-opus-4-6',
          max_tokens: maxTokens || 2800,
          system: systemPrompt || '',
          messages: [{ role: 'user', content: userContent }]
        });

        // 4. 사용 로그 저장
        await saveLog({
          classCode, studentName, isTeacher,
          grade, problem, htype,
          model: model || 'claude-opus-4-6',
          usage: response.usage
        });

        return res.json({
          content: response.content[0].text,
          usage: response.usage,
          remaining: usageInfo.remaining
        });

      } catch (e) {
        console.error('Claude API 오류:', e.message);
        // API 키 오류 메시지는 클라이언트에 노출하지 않음
        const msg = e.message.includes('API 키')
          ? '서버 설정 오류 — 관리자에게 문의하세요'
          : '잠시 오류가 났어요. 다시 시도해봐요! 🔄';
        return res.status(500).json({ error: msg });
      }
    });
  });

// ══════════════════════════════════════════════════
// 관리자 전용: API 키 설정 저장
// 선생님 관리자 화면에서 API 키를 Firebase에 저장할 때 사용
// ══════════════════════════════════════════════════
exports.setApiKey = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { adminCode, apiKey, classCode } = req.body;
      if (!adminCode || !apiKey) {
        return res.status(400).json({ error: '관리자 코드와 API 키가 필요합니다' });
      }

      // 관리자 코드 검증 (Firestore에서)
      try {
        const snap = await db.doc('config/settings').get();
        const storedAdmin = snap.exists ? snap.data().adminCode : null;

        // 첫 설정 시 (Firestore가 비어있으면) 허용
        if (storedAdmin && storedAdmin !== adminCode) {
          return res.status(403).json({ error: '관리자 코드가 틀렸어요 🔒' });
        }

        // API 키는 Functions 환경변수로 저장 권장이지만
        // 여기서는 Firestore admin 문서에 저장 (보안 규칙으로 클라이언트 접근 차단)
        await db.doc('config/teacher').set({
          apiKey,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 학급 코드도 함께 업데이트 (있을 경우)
        if (classCode) {
          await db.doc('config/settings').set({
            classCode,
            adminCode,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          await db.doc('config/settings').set({
            adminCode,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }

        return res.json({ success: true, message: '설정이 서버에 저장됐어요 ✅' });
      } catch (e) {
        console.error('설정 저장 오류:', e);
        return res.status(500).json({ error: '저장 중 오류가 났어요: ' + e.message });
      }
    });
  });

// ══════════════════════════════════════════════════
// 선생님용: 사용량 통계 조회
// ══════════════════════════════════════════════════
exports.getUsageStats = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { classCode, days = 7 } = req.body;
      const valid = await verifyClassCode(classCode);
      if (!valid) return res.status(403).json({ error: '학급 코드 불일치' });

      try {
        const results = [];
        for (let i = 0; i < Math.min(days, 30); i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().slice(0, 10);
          const snap = await db.collection(`usage/${dateStr}/users`).get();
          let total = 0;
          const students = [];
          snap.forEach(doc => {
            const data = doc.data();
            total += data.count || 0;
            students.push({ name: doc.id, count: data.count || 0, isTeacher: data.isTeacher });
          });
          results.push({ date: dateStr, total, students });
        }
        return res.json({ stats: results });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    });
  });
