import type { InviteDto, OrganizationDto, UserDto } from '@keyless/shared';
import type { IInvite } from '@keyless/core/models/Invite';
import type { IOrganization } from '@keyless/core/models/Organization';
import type { IUser } from '@keyless/core/models/User';

export function toUserDto(user: IUser): UserDto {
  return {
    id: user._id.toString(),
    orgId: user.orgId.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    twoFactorEnabled: user.twoFactor.enabled,
    isSuperAdmin: user.isSuperAdmin,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toOrgDto(org: IOrganization): OrganizationDto {
  return {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    country: org.country,
    timezone: org.timezone,
    currency: org.currency,
    plan: org.plan,
  };
}

export function toInviteDto(invite: IInvite): InviteDto {
  return {
    id: invite._id.toString(),
    email: invite.email,
    role: invite.role,
    invitedBy: invite.invitedBy.toString(),
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}
