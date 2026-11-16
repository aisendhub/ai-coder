import { Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"

export function SignIn() {
  const {
    signInWithGithub,
    signInWithGoogle,
    error,
    pending,
    retryOpen,
    cancelLogin,
  } = useAuth()

  return (
    <div className="min-h-svh flex items-center justify-center p-6">
      <div className="w-full max-w-sm flex flex-col items-center gap-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Sparkles className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">ai-coder</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Chat with your coding agent on your host, scoped to your project.
          </p>
        </div>

        {pending ? (
          <div className="w-full flex flex-col gap-3">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Waiting for sign-in in your browser…
            </div>
            <p className="text-xs text-muted-foreground">
              Complete the sign-in in the browser tab, then return here. This
              window will pick it up automatically.
            </p>
            <Button className="w-full" variant="outline" onClick={() => void retryOpen()}>
              Open browser again
            </Button>
            <Button className="w-full" variant="ghost" onClick={cancelLogin}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="w-full flex flex-col gap-2">
            <Button className="w-full" onClick={signInWithGoogle}>
              <img
                src="/brand/google-g.png"
                alt=""
                aria-hidden
                draggable={false}
                className="size-4 mr-2"
              />
              Continue with Google
            </Button>
            <Button className="w-full" variant="outline" onClick={signInWithGithub}>
              <img
                src="/brand/github-mark.png"
                alt=""
                aria-hidden
                draggable={false}
                className="size-4 mr-2 dark:invert"
              />
              Continue with GitHub
            </Button>
          </div>
        )}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <p className="text-xs text-muted-foreground">
          Sign in to create projects and keep conversations organized.
        </p>
      </div>
    </div>
  )
}
