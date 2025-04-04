// 이메일 HTML 템플릿 작성

export function questionEmail({ answerUrl }) {
    return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>질문이 도착했습니다!</h2>
      <p>아래 버튼을 눌러 질문에 답변해주세요:</p>
      <a href="${answerUrl}" style="
        display: inline-block;
        background-color: #007BFF;
        color: white;
        padding: 10px 20px;
        border-radius: 5px;
        text-decoration: none;
      ">답변하기</a>
    </div>
  `;
}
