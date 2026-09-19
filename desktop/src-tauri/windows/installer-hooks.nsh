; Tauri CLI 2.11.4 / tauri-bundler 2.9.4, commit
; 7cd71369c00978a3783b6ae3e9972358abbe4ae6 includes this after utils.nsh.
; Keep the stock template, but never use its forced process termination path.
!include "${__FILEDIR__}\payload-cleanup-generated.nsh"
!ifmacrondef CheckIfAppIsRunning
  !error "Expected pinned Tauri process-check macro is missing"
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  ; Both PRE hooks below already own the lease and check live processes.
!macroend

Var ACLeaseHandle
Var ACLeaseRoot
Var ACAllowUpdateWait
Var ACWaitDeadline
Var ACUserSid
Var ACUserTokenBuffer
Var ACCandidateSid
Var ACCandidateTokenBuffer
Var ACCandidateProcess
Var ACSnapshot
Var ACEntry
Var ACName

!macro AC_LEASE_FUNCTIONS Prefix
Function ${Prefix}ACLeaseFail
  DetailPrint "앱과 제어 서버를 정상 종료한 후 설치 프로그램을 다시 실행하십시오."
  MessageBox MB_OK|MB_ICONSTOP "설치 또는 제거를 시작할 수 없습니다. 앱과 제어 서버를 정상 종료한 후 다시 실행하십시오." /SD IDOK
  SetErrorLevel 2
  ; The installer process owns all handles. Quit closes them also on errors;
  ; never unlink the persistent lock or continue into the stock kill macro.
  Quit
FunctionEnd

; Only an official /UPDATE install may wait for the already-drained parent to
; finish its ShellExecuteW -> process exit handoff. Never wait indefinitely,
; skip a live process, or use this policy for ordinary install/uninstall.
Function ${Prefix}ACWaitForUpdate
  StrCmp $ACAllowUpdateWait 1 0 update_wait_failed
  System::Call 'kernel32::GetTickCount64() l.r0'
  System::Int64Op $0 < $ACWaitDeadline
  Pop $0
  IntCmp $0 1 0 update_wait_failed update_wait_failed
  Sleep 50
  Return
  update_wait_failed:
    Call ${Prefix}ACLeaseFail
FunctionEnd

Function ${Prefix}ACValidateLeaseRoot
  StrCpy $0 $ACLeaseRoot
  StrCpy $1 $0 1 1
  StrCmp $1 ":" 0 invalid_root
  StrCpy $1 $0 1 2
  StrCmp $1 "\" 0 invalid_root
  GetFullPathName $1 "$0"
  StrCmp $0 $1 0 invalid_root
  root_parent:
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
    IntCmp $1 -1 invalid_root
    IntOp $2 $1 & 0x410
    IntCmp $2 0x10 0 invalid_root invalid_root
    ${GetParent} "$0" $1
    StrCmp $1 "" root_valid
    StrCmp $1 $0 root_valid
    StrCpy $0 $1
    Goto root_parent
  invalid_root:
    Call ${Prefix}ACLeaseFail
  root_valid:
FunctionEnd

; Input: process handle. Output (top first): SID pointer, owning token buffer.
; The returned SID is used only while that allocated buffer remains alive.
Function ${Prefix}ACReadProcessSid
  Pop $0
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p.r1) i.r2'
  IntCmp $2 0 invalid_sid
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i.r2) i.r3'
  IntCmp $2 0 invalid_sid invalid_sid
  IntCmp $2 65536 0 0 invalid_sid
  System::Alloc $2
  Pop $3
  IntCmp $3 0 invalid_sid
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r3, i r2, *i.r4) i.r5'
  IntCmp $5 0 invalid_sid
  System::Call 'kernel32::CloseHandle(p r1)'
  System::Call '*$3(p.r4)'
  System::Call 'advapi32::IsValidSid(p r4) i.r5'
  IntCmp $5 0 invalid_sid
  Push $3
  Push $4
  Return
  invalid_sid:
    Call ${Prefix}ACLeaseFail
FunctionEnd

Function ${Prefix}ACCheckProcesses
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  Push $0
  Call ${Prefix}ACReadProcessSid
  Pop $ACUserSid
  Pop $ACUserTokenBuffer
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.r0'
  IntCmp $0 -1 process_failure
  StrCpy $ACSnapshot $0
  !if ${NSIS_PTR_SIZE} = 8
    !define AC_ENTRY_SIZE 568
    !define AC_ENTRY_NAME 44
  !else
    !define AC_ENTRY_SIZE 556
    !define AC_ENTRY_NAME 36
  !endif
  System::Alloc ${AC_ENTRY_SIZE}
  Pop $ACEntry
  IntCmp $ACEntry 0 process_failure
  System::Call '*$ACEntry(i ${AC_ENTRY_SIZE})'
  System::Call 'kernel32::Process32FirstW(p $ACSnapshot, p $ACEntry) i.r0'
  IntCmp $0 0 process_failure
  process_entry:
    IntOp $0 $ACEntry + ${AC_ENTRY_NAME}
    System::Call '*$0(&w260.r1)'
    StrCpy $ACName $1
    StrCmp $ACName "agent-company-beta.exe" process_candidate
    StrCmp $ACName "node-x86_64-pc-windows-msvc.exe" process_candidate process_next
  process_candidate:
    IntOp $0 $ACEntry + 8
    System::Call '*$0(i.r1)'
    ; Only the two exact names reach token/path queries. Any uncertainty is a
    ; retryable refusal, never evidence that the controller has stopped.
    System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i r1) p.r0'
    IntCmp $0 0 process_failure
    StrCpy $ACCandidateProcess $0
    IntOp $1 ${NSIS_MAX_STRLEN} * 2
    System::Alloc $1
    Pop $2
    IntCmp $2 0 process_failure
    StrCpy $3 ${NSIS_MAX_STRLEN}
    System::Call 'kernel32::QueryFullProcessImageNameW(p $ACCandidateProcess, i 0, p r2, *i r3) i.r4'
    IntCmp $4 0 process_failure
    System::Call '*$2(&w${NSIS_MAX_STRLEN}.r3)'
    System::Free $2
    ${GetFileName} "$3" $4
    StrCmp $4 $ACName 0 process_failure
    Push $ACCandidateProcess
    Call ${Prefix}ACReadProcessSid
    Pop $ACCandidateSid
    Pop $ACCandidateTokenBuffer
    System::Call 'advapi32::EqualSid(p $ACUserSid, p $ACCandidateSid) i.r0'
    IntCmp $0 0 different_user wait_for_candidate wait_for_candidate
  wait_for_candidate:
    StrCmp $ACAllowUpdateWait 1 0 process_failure
    ; SYNCHRONIZE + QUERY_LIMITED_INFORMATION pins this exact process. Waiting
    ; never treats a name/PID disappearance as proof that this owner exited.
    System::Call 'kernel32::WaitForSingleObject(p $ACCandidateProcess, i 0) i.r0'
    IntCmp $0 0 candidate_exited
    IntCmp $0 258 0 process_failure process_failure
    Call ${Prefix}ACWaitForUpdate
    Goto wait_for_candidate
  candidate_exited:
    Call ${Prefix}ACWaitForUpdate
    System::Free $ACCandidateTokenBuffer
    System::Call 'kernel32::CloseHandle(p $ACCandidateProcess)'
    System::Free $ACEntry
    System::Free $ACUserTokenBuffer
    System::Call 'kernel32::CloseHandle(p $ACSnapshot)'
    ; Recreate the snapshot and run every original check again while the same
    ; exclusive lease remains held. A later/orphan controller still blocks.
    Push 1
    Return
  different_user:
    System::Free $ACCandidateTokenBuffer
    System::Call 'kernel32::CloseHandle(p $ACCandidateProcess)'
  process_next:
    System::Call 'kernel32::Process32NextW(p $ACSnapshot, p $ACEntry) i.r0 ?e'
    Pop $1
    IntCmp $0 0 process_end process_entry process_entry
  process_end:
    ; Capture last-error inside the same System call; a later plugin invocation
    ; may overwrite the thread's error before GetLastError can observe it.
    IntCmp $1 18 0 process_failure process_failure
    System::Free $ACEntry
    System::Free $ACUserTokenBuffer
    System::Call 'kernel32::CloseHandle(p $ACSnapshot)'
    Push 0
    Return
  process_failure:
    Call ${Prefix}ACLeaseFail
  !undef AC_ENTRY_SIZE
  !undef AC_ENTRY_NAME
FunctionEnd

; The PRE hooks supply the current user's LOCALAPPDATA. A fixture may call this
; same function with a temporary root, without changing product path selection.
Function ${Prefix}ACAcquireInstallLease
  Pop $ACLeaseRoot
  System::Call 'kernel32::GetTickCount64() l.r0'
  System::Int64Op $0 + 10000
  Pop $ACWaitDeadline
  StrCmp $ACLeaseHandle "" 0 acquired_lease
  Call ${Prefix}ACValidateLeaseRoot
  System::Call 'kernel32::CreateFileW(w "$ACLeaseRoot\com.agentcompany.desktop.beta.install.lock", i 0xC0000000, i 3, p 0, i 4, i 0x00200080, p 0) p.r0'
  IntCmp $0 -1 invalid_lease
  StrCpy $ACLeaseHandle $0
  System::Call 'kernel32::GetFileType(p $ACLeaseHandle) i.r0'
  IntCmp $0 1 0 invalid_lease invalid_lease
  System::Alloc 52
  Pop $1
  IntCmp $1 0 invalid_lease
  System::Call 'kernel32::GetFileInformationByHandle(p $ACLeaseHandle, p r1) i.r0'
  IntCmp $0 0 invalid_lease
  System::Call '*$1(i.r2)'
  IntOp $2 $2 & 0x410
  IntCmp $2 0 0 invalid_lease invalid_lease
  IntOp $2 $1 + 40
  System::Call '*$2(i.r3)'
  IntCmp $3 1 0 invalid_lease invalid_lease
  System::Free $1
  ; OVERLAPPED: two pointer-sized fields, two DWORDs, and a handle, all zero.
  ; FAIL_IMMEDIATELY keeps this call synchronous; the one-byte range overlaps
  ; std::fs::File::try_lock_shared's full-file LockFileEx range on Rust 1.96.
  try_lease_lock:
  System::Call '*(p 0, p 0, i 0, i 0, p 0) p.r1'
  IntCmp $1 0 invalid_lease
  System::Call 'kernel32::LockFileEx(p $ACLeaseHandle, i 3, i 0, i 1, i 0, p r1) i.r0 ?e'
  Pop $4
  System::Free $1
  IntCmp $0 0 lease_busy
  Call ${Prefix}ACValidateLeaseRoot
  acquired_lease:
    Call ${Prefix}ACCheckProcesses
    Pop $0
    IntCmp $0 0 0 acquired_lease acquired_lease
    Return
  lease_busy:
    ; Only ERROR_LOCK_VIOLATION is retryable. Malformed paths, links, permission
    ; failures and all other errors still fail closed immediately.
    IntCmp $4 33 0 invalid_lease invalid_lease
    Call ${Prefix}ACWaitForUpdate
    Goto try_lease_lock
  invalid_lease:
    Call ${Prefix}ACLeaseFail
FunctionEnd
!macroend

!insertmacro AC_LEASE_FUNCTIONS ""
!insertmacro AC_LEASE_FUNCTIONS "un."

!macro NSIS_HOOK_PREINSTALL
  StrCpy $ACAllowUpdateWait 0
  ${If} $UpdateMode = 1
    StrCpy $ACAllowUpdateWait 1
  ${EndIf}
  Push "$LOCALAPPDATA"
  Call ACAcquireInstallLease
  !insertmacro AC_PAYLOAD_CLEANUP_PREPARE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro AC_PAYLOAD_CLEANUP_COMMIT
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $ACAllowUpdateWait 0
  Push "$LOCALAPPDATA"
  Call un.ACAcquireInstallLease
!macroend

; Do not release in POSTINSTALL: stock finish /R launches before installer exit.
; The new shell waits for this process to exit before opening payload/user data.
; A nested old uninstaller has its own lease and exits before PREINSTALL runs.
