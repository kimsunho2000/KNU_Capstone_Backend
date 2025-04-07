/* Entry Point */
import express from 'express'
import connectDB from './src/config/mongoose.js'
import subscribeRoutes from './src/routes/subscribeRoutes.js'
import authRoutes from "./src/routes/authRoutes.js"
import dotenv from 'dotenv'
import './src/cron/emailCron.js';
import {corsMiddleware} from "./src/middlewares/cors.js";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

/* 미들웨어 시작 CORS는 반드시 최상단에 위치해야함 */
app.use(corsMiddleware);
app.options('*', corsMiddleware); // 프리플라이트 요청 처리
app.use(express.json()); //JSON 파싱을 위한 미들웨어

dotenv.config();


app.get('/', (req, res) => {
    res.send('Hello World!');
});

// 라우터 설정
app.use('/api/subscribe', subscribeRoutes);
app.use('/api/auth', authRoutes);

// DB실행
connectDB();

// 서버 실행
app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
});