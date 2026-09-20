// ============================================================
// Firebase 설정 — 배포 전 반드시 채워주세요
// ============================================================
// 1. https://console.firebase.google.com 에서 새 프로젝트 생성
// 2. 프로젝트 설정(톱니바퀴) > 일반 > "내 앱" 에서 웹 앱(</>) 추가
// 3. 거기서 보여주는 firebaseConfig 값을 아래에 그대로 붙여넣기
//    (이 값들은 비밀키가 아니라 공개되어도 되는 클라이언트 식별자입니다.
//     실제 보안은 Firebase Authentication + Firestore 보안 규칙이 담당합니다.)
// 4. Authentication > Sign-in method 에서 "이메일/비밀번호" 제공업체를 사용 설정
// 5. Firestore Database 를 만들고(프로덕션 모드), 규칙은 아래 firestore.rules 파일 참고
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyAzaMQTSTYWoMz1fJ9aqv3sFYrsXtgjI8M",
  authDomain: "gieoksoop.firebaseapp.com",
  projectId: "gieoksoop",
  storageBucket: "gieoksoop.firebasestorage.app",
  messagingSenderId: "708776461006",
  appId: "1:708776461006:web:d7d12921208eebfcf7869f",
};
