import mongoose from "mongoose";
import { getAnswerFromGroq, getFeedbackFromGroq } from "./aiService.js";
import { Question } from "../models/questions.js";
import { parseFeedback } from "../utils/parseToJSON.js";
import Answer from "../models/answer.js";
import { UserActivity } from "../models/userActivity.js";
import User from "../models/users.js";
import { updateUserStreak } from "./userService.js";
import { createLogger } from "../utils/logger.js";
import { getKSTDateString } from "../utils/date.js";
import { checkDailyApiUsageLimit, recordApiUsage } from "./apiUsageService.js";

//로거 생성
const logger = createLogger('answerService');

/*
    사용자가 답변을 입력하거나 정답 요청을 했을때의 비지니스 로직
 */

// email을 통해 개인 UID를 반환하는 함수
async function getUid(email) {
    const user = await User
        .findOne({ email })
        .select("_id")
        .lean();
    if (!user) {
        logger.error('사용자를 조회 실패', {
            email: email
        });
        throw new Error
    }
    return user._id;
}

// 사용자가 입력한 답변을 채점하고 DB에 저장후 반환
export async function returnFeedBack(email, questionId, userAnswer) {
    try {
        const userId = await getUid(email);
        const date = getKSTDateString();

        // API 사용량 제한 확인
        const canUseApi = await checkDailyApiUsageLimit(email, date);
        if (!canUseApi) {
            logger.warn('일일 API 사용량 제한 초과', {
                email: email,
                date: date
            });
            return {
                error: true
            };
        }

        // 이미 제출한 일반 답변이 있으면 업데이트
        let answerDoc = await Answer.findOne({
            user: userId,
            question: questionId,
            revealedAnswer: false
        });

        // 질문 텍스트 조회
        const userQuestion = await Question
            .findById(questionId)
            .select("text")
            .lean();
        if (!userQuestion) {
            logger.error('질문 조회 실패', {
                userQuestion: userQuestion,
                email: email
            });
            throw new Error
        }
        const text = userQuestion.text;

        // AI 피드백 요청 및 JSON 파싱
        const result = parseFeedback(
            await getFeedbackFromGroq(text, userAnswer)
        );
        /*
            result 예시:
            {
                score: 100,
                strengths: [...],
                improvements: [...],
                wrongPoints: [...]
            }
        */

        // API 사용량 기록
        await recordApiUsage(email, date);

        if (answerDoc) {
            // 기존 답변 업데이트
            answerDoc.answerText    = userAnswer;
            answerDoc.score         = result.score;
            answerDoc.strengths     = result.strengths;
            answerDoc.improvements  = result.improvements;
            answerDoc.wrongPoints   = result.wrongPoints;
            await answerDoc.save();
        } else {
            // 신규 저장 (트랜잭션 포함)
            answerDoc = await saveFeedbackToDatabase(
                userId, questionId, userAnswer, result
            );
        }

        return {
            score:        answerDoc.score,
            strengths:    answerDoc.strengths,
            improvements: answerDoc.improvements,
            wrongPoints:  answerDoc.wrongPoints
        };
    } catch (error) {
        logger.error('피드백 처리 중 오류:', {
            error: error.message,
            stack: error.stack,
            questionId: questionId,
            email: email
        });
        throw error;
    }
}


// 사용자가 "모르겠어요" 버튼을 눌렀을때 정답을 반환하고 DB에 저장
export async function returnAnswer(email, questionId) {
    const date = getKSTDateString();
    try {
        const userId = await getUid(email);

        // 이미 aiAnswer 저장된 경우 DB 값만 반환 (API 호출 없음)
        let answerDoc = await Answer.findOne({
            user: userId,
            question: questionId,
            revealedAnswer: true
        }).lean();
        if (answerDoc) return answerDoc.aiAnswer;

        // API 사용량 제한 확인
        const canUseApi = await checkDailyApiUsageLimit(email, date);
        if (!canUseApi) {
            logger.warn('일일 API 사용량 제한 초과', {
                email: email,
                date: date
            });
            return {
                error: true
            };
        }

        // 질문 텍스트 조회
        const userQuestion = await Question
            .findById(questionId)
            .select("text")
            .lean();
        if (!userQuestion) {
            logger.error('질문 조회 실패', {
                userQuestion: userQuestion,
                email: email
            })
            throw new Error;
        };

        // AI 모범답안 호출
        const aiText = await getAnswerFromGroq(userQuestion.text);

        // API 사용량 기록
        await recordApiUsage(email, date);

        // DB에 저장 (트랜잭션 포함)
        saveFeedbackToDatabase(
            userId, questionId, "", { aiAnswer: aiText }
        ).catch(error => logger.error('AI 정답 저장 실패:', {
            error: error.message,
            stack: error.stack,
            questionId: questionId,
            email: email
        }));
        return aiText;
    } catch (error) {
        logger.error('AI 정답 생성 및 처리 중 오류:', {
            error: error.message,
            stack: error.stack,
            questionId: questionId,
            email: email
        });
        throw error;
    }
}


/**
 * 피드백 또는 AI 답변을 원자적으로 저장하고 UserActivity를 업데이트(트랜잭션 처리)
 */
async function saveFeedbackToDatabase(userId, questionId, userAnswer, feedback) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        await updateUserStreak(userId,session).catch(error => logger.error('스트릭 업데이트 실패:', {
            error: error.message,
            stack: error.stack,
            userId: userId
        }));
        // category 조회
        const category = await getActivityCategory(userId, questionId, session);
        // Answer 저장용 데이터 구조화
        const answerData = buildAnswerData(userId, questionId, category, userAnswer, feedback);

        // Answer 생성
        const answer = await new Answer(answerData).save({ session });
        // UserActivity 업데이트
        await updateUserActivity(userId, questionId, answer._id, answerData.revealedAnswer, session);

        await session.commitTransaction();
        logger.info('답변 저장 및 UserActivity 업데이트 완료', {
            userId: userId,
            answerId: answer._id
        });
        return answer;
    } catch (error) {
        await session.abortTransaction();
        logger.error('saveFeedbackToDatabase error:', {
            error: error.message,
            stack: error.stack,
            questionId: questionId,
            userId: userId
        });
        throw error;
    } finally {
        session.endSession();
    }
}

/** UserActivity 또는 Question에서 category 조회 */
async function getActivityCategory(userId, questionId, session) {
    const ua = await UserActivity.findOne({ user: userId, question: questionId })
        .session(session)
        .lean();
    if (ua?.category) return ua.category;
    const q = await Question.findById(questionId)
        .select("category")
        .session(session)
        .lean();
    return q?.category ?? "unknown";
}

/** Answer 생성에 필요한 데이터 구조화 */
function buildAnswerData(userId, questionId, category, userAnswer, feedback) {
    const isReveal = userAnswer === "";
    return {
        user:           userId,
        question:       questionId,
        category,
        answerText:     userAnswer || "정답 요청",
        score:          feedback.score || 0,
        strengths:      feedback.strengths || [],
        improvements:   feedback.improvements || [],
        wrongPoints:    feedback.wrongPoints || [],
        revealedAnswer: isReveal,
        aiAnswer:       isReveal ? (feedback.aiAnswer || "") : undefined
    };
}

/** UserActivity에 Answer ID를 추가 */
async function updateUserActivity(userId, questionId, answerId, revealedAnswer, session) {
    const field = revealedAnswer ? "aiAnswer" : "answers";
    await UserActivity.updateOne(
        { user: userId, question: questionId },
        { $set: { [field]: answerId } },
        { upsert: true, session }
    );
}