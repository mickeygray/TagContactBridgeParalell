import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowRight, Mail, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toaster";
import {
  useSendCodeMutation,
  useVerifyCodeMutation,
} from "@/lib/api/queries/auth";
import { useAuthStore } from "@/lib/auth/authStore";
import { postLoginPathForUser } from "@/lib/auth/landing";
import type { SendCodeResponse } from "@/lib/api/types";

const emailSchema = z.object({
  email: z.string().email("Enter a valid email"),
});
const codeSchema = z.object({
  code: z.string().min(4, "Code is at least 4 characters"),
});

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { redirectTo?: string } | null)?.redirectTo;

  const [step, setStep] = React.useState<"email" | "code">("email");
  const [challenge, setChallenge] = React.useState<SendCodeResponse | null>(null);

  const sendCode = useSendCodeMutation();
  const verifyCode = useVerifyCodeMutation();
  const setSession = useAuthStore((s) => s.setSession);
  const existingToken = useAuthStore((s) => s.token);
  const existingUser = useAuthStore((s) => s.user);

  React.useEffect(() => {
    if (existingToken && existingUser) {
      navigate(postLoginPathForUser(existingUser, redirectTo), { replace: true });
    }
  }, [existingToken, existingUser, navigate, redirectTo]);

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: "" },
  });

  const codeForm = useForm<z.infer<typeof codeSchema>>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });

  async function onSubmitEmail(values: z.infer<typeof emailSchema>) {
    try {
      const res = await sendCode.mutateAsync(values.email);
      setChallenge(res);
      setStep("code");
      if (res.previewCode) {
        codeForm.setValue("code", res.previewCode);
      }
      toast.success("Login code sent", { description: res.email });
    } catch (err) {
      toast.error("Could not send code", {
        description: (err as Error).message,
      });
    }
  }

  async function onSubmitCode(values: z.infer<typeof codeSchema>) {
    if (!challenge) return;
    try {
      const res = await verifyCode.mutateAsync({
        email: challenge.email,
        code: values.code,
        challengeId: challenge.challengeId,
      });
      setSession(res.token, res.user);
      toast.success("Welcome", { description: res.user.email });
      navigate(postLoginPathForUser(res.user, redirectTo), { replace: true });
    } catch (err) {
      toast.error("Could not sign in", { description: (err as Error).message });
    }
  }

  return (
    <div className="shell-gradient flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            TagContactBridge
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with your work email.
          </p>
        </div>

        <div className="surface p-6">
          {step === "email" ? (
            <form
              className="space-y-4"
              onSubmit={emailForm.handleSubmit(onSubmitEmail)}
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  leadingIcon={<Mail />}
                  placeholder="you@taxadvocategroup.com"
                  {...emailForm.register("email")}
                />
                {emailForm.formState.errors.email ? (
                  <p className="text-xs text-destructive">
                    {emailForm.formState.errors.email.message}
                  </p>
                ) : null}
              </div>
              <Button
                type="submit"
                className="w-full"
                isLoading={sendCode.isPending}
              >
                Send code
                <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          ) : (
            <form
              className="space-y-4"
              onSubmit={codeForm.handleSubmit(onSubmitCode)}
            >
              <div className="space-y-1.5">
                <Label htmlFor="code">One-time code</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  leadingIcon={<KeyRound />}
                  placeholder="Enter the 6-digit code"
                  {...codeForm.register("code")}
                />
                {codeForm.formState.errors.code ? (
                  <p className="text-xs text-destructive">
                    {codeForm.formState.errors.code.message}
                  </p>
                ) : null}
                {challenge?.previewCode ? (
                  <p className="text-xs text-muted-foreground">
                    Preview mode — auto-filled from 5001.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    We sent a code to {challenge?.email}.
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep("email")}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  isLoading={verifyCode.isPending}
                >
                  Verify & sign in
                </Button>
              </div>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          3001 · talks only to 5001
        </p>
      </div>
    </div>
  );
}
