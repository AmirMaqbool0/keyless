import type { Types } from 'mongoose';
import type { OrganizationDoc } from '@keyless/core/models/Organization';
import type { UserDoc } from '@keyless/core/models/User';

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate` when the access token is valid. orgId always comes from here. */
      auth?: { user: UserDoc; org: OrganizationDoc; orgId: Types.ObjectId };
      /** Why authentication failed, so the client can tell "expired" (refresh) from "signed out". */
      authError?: 'TOKEN_EXPIRED' | 'INVALID_TOKEN';
    }
  }
}

export {};
