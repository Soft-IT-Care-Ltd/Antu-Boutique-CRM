import type { RoleName } from "@prisma/client";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role: RoleName;
    teamId: string | null;
    mustChangePassword: boolean;
  }

  interface Session {
    user: {
      id: string;
      role: RoleName;
      teamId: string | null;
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: RoleName;
    teamId: string | null;
    mustChangePassword: boolean;
  }
}
