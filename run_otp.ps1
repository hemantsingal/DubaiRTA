$JavaPath = "C:\Program Files\Eclipse Adoptium\jdk-21.0.9.10-hotspot\bin\java.exe"
& $JavaPath -Xmx4G -jar otp/otp-shaded-2.8.1.jar --load otp --serve
