// ============================================================
// 기억숲 — Firebase 인증 공용 모듈
// 모든 페이지의 <script type="module"> 에서 이 파일을 import 해서 씁니다.
// ============================================================
import { firebaseConfig } from "./fbconfig.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendEmailVerification,
  applyActionCode,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  reauthenticateWithCredential,
  updatePassword,
  EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 이메일 인증 / 비밀번호 재설정 링크가 클릭됐을 때 도착할 페이지.
// 배포된 도메인이 바뀌어도(gieoksoop.com, admin.gieoksoop.com 등 신경 쓸 필요 없이)
// 항상 "지금 이 사이트의 auth-action.html"을 가리키도록 origin을 그대로 사용한다.
const actionCodeSettings = {
  url: `${window.location.origin}/auth-action.html`,
  handleCodeInApp: true,
};

// 회원가입: Firebase Auth에 계정 생성 + Firestore에 회원 프로필 문서 저장 + 인증 메일 발송
export async function signUp(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: name });
  await setDoc(doc(db, "users", cred.user.uid), {
    name: name,
    email: email,
    created_at: serverTimestamp(),
    subscription_status: "none", // none | active | canceled — 결제 연동 전까지는 항상 none
    subscription_plan: null,
  });
  await sendEmailVerification(cred.user, actionCodeSettings);
  return cred.user;
}

export async function logIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logOut() {
  await signOut(auth);
}

// 인증 메일 재발송 (로그인은 되어 있지만 아직 이메일 인증을 안 한 사용자용)
export async function resendVerificationEmail(user) {
  await sendEmailVerification(user, actionCodeSettings);
}

// auth-action.html: 이메일의 인증 링크(mode=verifyEmail)를 눌렀을 때 처리
export async function completeEmailVerification(oobCode) {
  await applyActionCode(auth, oobCode);
}

// 비밀번호 찾기: 재설정 링크 메일 발송
export async function requestPasswordReset(email) {
  await sendPasswordResetEmail(auth, email, actionCodeSettings);
}

// auth-action.html: 비밀번호 재설정 링크(mode=resetPassword)의 코드가 유효한지 확인하고
// 어떤 계정의 재설정인지(이메일) 반환
export async function verifyResetCode(oobCode) {
  return await verifyPasswordResetCode(auth, oobCode);
}

// auth-action.html: 새 비밀번호로 재설정 완료
export async function completePasswordReset(oobCode, newPassword) {
  await confirmPasswordReset(auth, oobCode, newPassword);
}

// 계정 화면(로그인 상태)에서 비밀번호 변경: 보안을 위해 현재 비밀번호로 재인증 후 변경
export async function changePassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  if (!user || !user.email) throw { code: "auth/requires-recent-login" };
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

// 로그인 상태에 따라 nav 영역을 자동으로 바꿔주는 공용 함수.
// 각 페이지의 <nav id="sitenav-links">에 data-auth="guest"/"user" 항목을 넣어두면
// 로그인 여부에 따라 보이고/숨겨집니다.
export function watchAuthForNav() {
  onAuthStateChanged(auth, (user) => {
    document.querySelectorAll('[data-auth="guest"]').forEach((el) => {
      el.style.display = user ? "none" : "";
    });
    document.querySelectorAll('[data-auth="user"]').forEach((el) => {
      el.style.display = user ? "" : "none";
    });
    document.querySelectorAll('[data-user-name]').forEach((el) => {
      if (user) el.textContent = user.displayName || user.email;
    });
  });
}

export function friendlyAuthError(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/email-already-in-use": "이미 가입된 이메일이에요. 로그인해 주세요.",
    "auth/invalid-email": "이메일 형식을 확인해 주세요.",
    "auth/weak-password": "비밀번호는 6자 이상이어야 해요.",
    "auth/user-not-found": "가입되지 않은 이메일이에요.",
    "auth/wrong-password": "비밀번호가 올바르지 않아요.",
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않아요.",
    "auth/too-many-requests": "잠시 후 다시 시도해 주세요.",
    "auth/expired-action-code": "인증 링크가 만료됐어요. 다시 요청해 주세요.",
    "auth/invalid-action-code": "이미 사용됐거나 유효하지 않은 링크예요.",
    "auth/user-disabled": "비활성화된 계정이에요.",
    "auth/requires-recent-login": "보안을 위해 로그아웃 후 다시 로그인하고 시도해 주세요.",
  };
  return map[code] || "문제가 발생했어요. 잠시 후 다시 시도해 주세요.";
}
