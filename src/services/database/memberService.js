import {
  readSchoolTeacher,
  readUserPointer,
  registerSchoolTeacher,
  restoreSoftRemovedTeacher,
  softRemoveTeacher,
  subscribeActiveSchoolTeachers,
  subscribeSchoolTeachers,
  updateTeacherAdmin,
  updateTeacherApprover,
  updateTeacherStatus,
} from './centralSchoolStore.js';

export function subscribeMembers(schoolId, callback, onStatus) {
  return subscribeSchoolTeachers(schoolId, callback, onStatus);
}

export function subscribeActiveMembers(schoolId, callback, onStatus) {
  return subscribeActiveSchoolTeachers(schoolId, callback, onStatus);
}

export async function readMember(schoolId, memberId) {
  return readSchoolTeacher(schoolId, memberId);
}

export async function readUserSchoolPointer(uid) {
  return readUserPointer(uid);
}

export async function registerMember(schoolId, member, options = {}) {
  return registerSchoolTeacher(schoolId, member, options);
}

export async function setMemberStatus(schoolId, memberId, status, actor = null) {
  return updateTeacherStatus(schoolId, memberId, status, actor);
}

export async function setMemberApprover(schoolId, memberId, canApprove, actor = null) {
  return updateTeacherApprover(schoolId, memberId, canApprove, actor);
}

export async function setMemberAdmin(schoolId, memberId, isAdmin, actor = null) {
  return updateTeacherAdmin(schoolId, memberId, isAdmin, actor);
}

export async function removeMember(schoolId, memberId, actor = null) {
  return softRemoveTeacher(schoolId, memberId, actor);
}

export async function restoreMember(schoolId, memberId, actor = null) {
  return restoreSoftRemovedTeacher(schoolId, memberId, actor);
}

export default {
  subscribeMembers,
  subscribeActiveMembers,
  readMember,
  readUserSchoolPointer,
  registerMember,
  setMemberStatus,
  setMemberApprover,
  setMemberAdmin,
  removeMember,
  restoreMember,
};