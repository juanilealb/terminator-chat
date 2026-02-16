!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\TerminatorChat" "" "Open in Terminator Chat"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\TerminatorChat" "Icon" "$INSTDIR\Terminator Chat.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\TerminatorChat\command" "" '$\"$INSTDIR\Terminator Chat.exe$\" $\"%V$\"'

  WriteRegStr HKCU "Software\Classes\Directory\shell\TerminatorChat" "" "Open in Terminator Chat"
  WriteRegStr HKCU "Software\Classes\Directory\shell\TerminatorChat" "Icon" "$INSTDIR\Terminator Chat.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\TerminatorChat\command" "" '$\"$INSTDIR\Terminator Chat.exe$\" $\"%V$\"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\TerminatorChat"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\TerminatorChat"
!macroend
