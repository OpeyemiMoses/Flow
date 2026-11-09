import {
  accountId,
  createBusiness,
  readAccounts,
  renameAccount,
} from "../../../../server/accounts.ts";
import {
  readActivities,
  syncActivities,
} from "../../../../server/activities.ts";
import { api, reply } from "../../../../server/http.ts";
import {
  createPaymentRequest,
  getPaymentRequest,
  listPaymentRequests,
  updatePaymentRequest,
} from "../../../../server/payment-requests.ts";
import {
  readPortfolio,
  refreshPortfolio,
} from "../../../../server/portfolio.ts";
import {
  changeMember,
  invite,
  readTeam,
  revokeInvite,
} from "../../../../server/team.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ action?: string[] }> },
) {
  return api(async () => {
    const parts = (await context.params).action ?? [];
    const [id, section, child] = parts;
    if (parts.length === 0) {
      if (request.method === "GET") return readAccounts(request);
      if (request.method === "POST") return createBusiness(request);
    }
    if (id && parts.length === 1) {
      if (request.method === "GET") return readAccounts(request, accountId(id));
      if (request.method === "PATCH")
        return renameAccount(request, accountId(id));
    }
    if (id && parts.length === 2) {
      if (request.method === "GET" && section === "members")
        return readTeam(request, accountId(id));
      if (request.method === "POST" && section === "invites")
        return invite(request, accountId(id));
      if (section === "portfolio") {
        if (request.method === "GET")
          return readPortfolio(request, accountId(id));
        if (request.method === "POST")
          return refreshPortfolio(request, accountId(id));
      }
      if (section === "activities") {
        if (request.method === "GET")
          return readActivities(request, accountId(id));
        if (request.method === "POST")
          return syncActivities(request, accountId(id));
      }
      if (section === "payment-requests") {
        if (request.method === "GET")
          return listPaymentRequests(request, accountId(id));
        if (request.method === "POST")
          return createPaymentRequest(request, accountId(id));
      }
    }
    if (id && child && parts.length === 3) {
      if (section === "payment-requests") {
        if (request.method === "GET")
          return getPaymentRequest(request, accountId(id), child);
        if (request.method === "PATCH")
          return updatePaymentRequest(request, accountId(id), child);
      }
      if (
        section === "portfolio" &&
        child === "refresh" &&
        request.method === "POST"
      ) {
        return refreshPortfolio(request, accountId(id));
      }
      if (
        section === "activities" &&
        child === "sync" &&
        request.method === "POST"
      ) {
        return syncActivities(request, accountId(id));
      }
      if (
        section === "members" &&
        ["PATCH", "DELETE"].includes(request.method)
      ) {
        return changeMember(
          request,
          accountId(id),
          accountId(child),
          request.method === "DELETE",
        );
      }
      if (section === "invites" && request.method === "DELETE")
        return revokeInvite(request, accountId(id), accountId(child));
    }
    return reply(404, { error: "NOT_FOUND" });
  });
}

export const POST = GET;
export const PATCH = GET;
export const DELETE = GET;
