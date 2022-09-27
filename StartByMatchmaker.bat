start cmd /k "%~dp0Samples\PixelStreaming\WebServers\Matchmaker\run.bat" ^
--CirrusRunPath=%~dp0Samples\PixelStreaming\WebServers\SignallingWebServer\platform_scripts\cmd\runAWS_WithTURN.bat ^
--StreamerRunPath=%~dp0FGWX.exe ^
--HttpPort=8443 ^
--MatchmakerPort=9999 ^
--ControllerInterval=60 ^
--MinAvailableServer=2 ^
--StartPort=7000 ^
--EndPort=7018 ^
--Address=ue.dxbim.com ^
--ResX=1920 ^
--ResY=1080 ^
--UeConfigIniPath=%~dp0FGWX\config.ini ^
--UeUdpSenderPortStart=19032 ^
--UeUdpRecievePortStart=6060



