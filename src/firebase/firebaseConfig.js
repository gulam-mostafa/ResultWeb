import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, FacebookAuthProvider } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyDakthwk-ea_jS53Dzu-KTkvTLoWL5ELJo',
  authDomain: 'primary-result.firebaseapp.com',
  databaseURL: 'https://primary-result-default-rtdb.firebaseio.com',
  projectId: 'primary-result',
  storageBucket: 'primary-result.firebasestorage.app',
  messagingSenderId: '279830355302',
  appId: '1:279830355302:web:48fb001c07b725c052bca7',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();
export const facebookProvider = new FacebookAuthProvider();
