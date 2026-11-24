"use client";

import { motion } from "framer-motion";
import { Eye, EyeOff, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { api, errorText, fetcher } from "@/client/api";
import { useT } from "@/client/i18n";
import { clearPersistentCache } from "@/app/providers";
import { AmbientBackground } from "@/components/app/AmbientBackground";
import { Wordmark } from "@/components/app/Wordmark";
import { Button, IconButton } from "@/components/ui/Button";
import { Field } from "@/components/ui/Controls";
import { deviceTimeZone } from "@/lib/dates";

type Mode = "login" | "register";

export function AuthForm({ mode }: { mode: Mode }) {
  const t = useT();
  const a = t.auth;
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { data: config } = useSWR<{ inviteRequired: boolean }>(mode === "register" ? "/api/auth/config" : null, fetcher);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  const validate = () => {
    const errors: typeof fieldErrors = {};
    if (mode === "register" && !name.trim()) errors.name = a.errName;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errors.email = a.errEmail;
    if (mode === "register" ? password.length < 8 : password.length === 0) errors.password = a.errPassword;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const timezone = deviceTimeZone();
      if (mode === "register") {
        await api("/api/auth/register", { body: { name: name.trim(), email: email.trim(), password, inviteCode: invite.trim() || undefined, timezone } });
      } else {
        await api("/api/auth/login", { body: { email: email.trim(), password, timezone } });
      }
      // Данные предыдущего пользователя не должны мелькнуть у нового.
      clearPersistentCache();
      await mutate(() => true, undefined, { revalidate: false });
      router.replace("/");
    } catch (err) {
      setFormError(errorText(t, err));
      setBusy(false);
    }
  };

  const isRegister = mode === "register";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-5 pb-safe pt-safe">
      <AmbientBackground />
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="py-8"
      >
        <div className="mb-8 px-1">
          <Wordmark className="text-[72px]" />
          <p className="mt-3 text-[17px] text-muted-strong">{a.tagline}</p>
        </div>

        <form onSubmit={submit} noValidate className="glass p-5">
          <h1 className="t-title">{isRegister ? a.registerTitle : a.loginTitle}</h1>
          <p className="mt-1 text-[15px] leading-snug text-muted-strong">{isRegister ? a.registerSubtitle : a.loginSubtitle}</p>

          <div className="mt-5 flex flex-col gap-4">
            {isRegister && (
              <Field
                label={a.name}
                name="name"
                autoComplete="given-name"
                placeholder={a.namePlaceholder}
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={fieldErrors.name}
                maxLength={60}
                required
              />
            )}
            <Field
              label={a.email}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              required
            />
            <Field
              label={a.password}
              name="password"
              type={show ? "text" : "password"}
              autoComplete={isRegister ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              hint={isRegister ? a.passwordHint : undefined}
              required
              trailing={
                <IconButton label={show ? a.hidePassword : a.showPassword} tone="plain" size={40} aria-pressed={show} onClick={() => setShow((v) => !v)}>
                  {show ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
                </IconButton>
              }
            />
            {isRegister && config?.inviteRequired && (
              <Field
                label={a.invite}
                name="invite"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                hint={a.inviteHint}
              />
            )}
          </div>

          {formError && (
            <p ref={errorRef} tabIndex={-1} role="alert" className="mt-4 rounded-[16px] bg-danger-soft px-4 py-3 text-[14.5px] font-medium text-danger outline-none">
              {formError}
            </p>
          )}

          <Button type="submit" size="lg" block loading={busy} className="mt-5">
            {isRegister ? a.register : a.login}
          </Button>
        </form>

        <p className="mt-5 text-center text-[15px] text-muted-strong">
          {isRegister ? a.haveAccount : a.noAccount}{" "}
          <Link href={isRegister ? "/login" : "/register"} className="rounded-md font-semibold text-leaf-deep underline-offset-4 hover:underline">
            {isRegister ? a.toLogin : a.toRegister}
          </Link>
        </p>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[13px] text-muted-strong">
          <Lock aria-hidden="true" size={13} />
          {a.privacy}
        </p>
      </motion.div>
    </main>
  );
}
