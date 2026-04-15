import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"

export function SignIn() {
  const { signInWithGithub } = useAuth()
  return (
    <div className="min-h-svh flex items-center justify-center p-6">
      <div className="w-full max-w-sm flex flex-col items-center gap-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Sparkles className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">ai-coder</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Chat with Claude Code on your host, scoped to your project.
          </p>
        </div>
        <Button className="w-full" onClick={signInWithGithub}>
          <GithubIcon className="size-4 mr-2" />
          Continue with GitHub
        </Button>
        <p className="text-xs text-muted-foreground">
          Sign in to create projects and keep conversations organized.
        </p>
      </div>
    </div>
  )
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 .5C5.73.5.67 5.56.67 11.83c0 5.02 3.25 9.27 7.77 10.77.57.1.78-.25.78-.55 0-.27-.01-.98-.02-1.93-3.16.69-3.83-1.52-3.83-1.52-.52-1.31-1.26-1.66-1.26-1.66-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.74.4-1.24.72-1.52-2.52-.29-5.18-1.26-5.18-5.6 0-1.24.44-2.25 1.17-3.04-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.16a10.9 10.9 0 0 1 5.74 0c2.18-1.47 3.14-1.16 3.14-1.16.63 1.57.23 2.73.11 3.02.73.79 1.17 1.8 1.17 3.04 0 4.35-2.66 5.3-5.19 5.59.41.35.77 1.04.77 2.1 0 1.52-.01 2.75-.01 3.12 0 .3.21.66.79.55 4.51-1.5 7.76-5.75 7.76-10.77C23.33 5.56 18.27.5 12 .5z"
      />
    </svg>
  )
}
