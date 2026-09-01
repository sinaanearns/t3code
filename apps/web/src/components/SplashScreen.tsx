export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label="Rearvy Coding Agent splash screen"
      >
        <img
          alt="Rearvy Coding Agent"
          className="size-16 object-contain"
          src="/apple-touch-icon.png"
        />
      </div>
    </div>
  );
}
