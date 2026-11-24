"use client";

import { motion } from "framer-motion";
import { ArchiveRestore, ArrowRight, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useSWRConfig } from "swr";
import { api, errorText } from "@/client/api";
import { useT } from "@/client/i18n";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { deviceTimeZone } from "@/lib/dates";
import { importBackup } from "@/local/backup";
import { AmbientBackground } from "./AmbientBackground";
import { Wordmark } from "./Wordmark";

/** Первый запуск: аккаунтов нет, поэтому достаточно имени — оно появится в приветствии и в титрах фильмов. */
export function Welcome() {
  const t = useT();
  const w = t.welcome;
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(w.errName);
      return;
    }
    setBusy(true);
    try {
      await api("/api/me", { method: "POST", body: { name: name.trim(), timezone: deviceTimeZone() } });
      await mutate("/api/me");
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    setRestoring(0);
    try {
      const result = await importBackup(file, (p) => setRestoring(p.totalBytes > 0 ? p.doneBytes / p.totalBytes : 0));
      toast(w.restored(result.moments, result.films), "success");
      await mutate((key) => typeof key === "string" && key.startsWith("/api/"));
    } catch {
      toast(w.restoreFailed, "error");
    } finally {
      setRestoring(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center px-6 pb-10 pt-safe">
      <AmbientBackground calm />
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
        <Wordmark className="text-[64px]" />
        <p className="mt-1 font-serif text-[22px] italic leading-snug text-leaf-deep">{w.tagline}</p>
        <h1 className="t-display mt-8">{w.title}</h1>
        <p className="mt-2.5 text-[16px] leading-snug text-muted-strong">{w.text}</p>

        <form onSubmit={(e) => void submit(e)} className="glass mt-6 flex flex-col gap-4 p-5" noValidate>
          <Field
            label={w.nameLabel}
            placeholder={w.namePlaceholder}
            value={name}
            maxLength={60}
            autoComplete="given-name"
            enterKeyHint="done"
            error={error}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" size="lg" block loading={busy} icon={<ArrowRight aria-hidden="true" size={20} />}>
            {w.start}
          </Button>
        </form>

        <p className="mt-5 flex items-start gap-2.5 text-[14px] leading-snug text-muted-strong">
          <ShieldCheck aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-leaf-deep" />
          <span>{w.privacy}</span>
        </p>

        <input ref={fileRef} type="file" accept=".zip,application/zip" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void restore(e.target.files?.[0])} />
        <Button
          variant="ghost"
          size="sm"
          className="mt-4"
          loading={restoring !== null}
          icon={<ArchiveRestore aria-hidden="true" size={17} />}
          onClick={() => fileRef.current?.click()}
        >
          {restoring !== null ? w.restoring(Math.round(restoring * 100)) : w.restore}
        </Button>
      </motion.div>
    </main>
  );
}
