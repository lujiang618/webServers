# 执行完不关闭窗口
# start cmd /k echo Hello, world!

# 执行完关闭窗口
# start cmd /c echo Hello, world!

start cmd /k "%~dp0arg.bat" ^
--width 3 ^
--height 3 ^
--port 3098 ^
--path %~dp0SFU


