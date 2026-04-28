"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminFetch } from "@/app/admin/lib/api";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await adminFetch("/login", { method: "DELETE" });
    router.push("/admin/login");
  }

  return (
    <Button
      onClick={handleLogout}
      variant="ghost"
      className="w-full justify-start gap-3 px-3 text-muted-foreground"
    >
      <LogOut />
      Logout
    </Button>
  );
}
