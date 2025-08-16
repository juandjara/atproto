import { InvalidRecordKeyError } from "@atproto/syntax";
import { InvalidRequestError, InternalServerError } from "@atproto/xrpc-server";
import { AppContext } from "../../../../context";
import { Server } from "../../../../lexicon";
import * as LEX from "../../../../lexicon/lexicons";
import { AtUri } from "@atproto/syntax";
import { touchRelationship } from "../../../../authz/spicedb";
import {
  atproto2spicedb,
  aturi2spicedb,
  checkPermission,
  dualWriteTransaction,
  preflightChecks,
  BadCommitSwapError,
  InvalidRecordError,
  PreparedCreate,
  prepareCreate,
  prepareDelete,
} from "../../../../space";
import { ActorStoreTransactor } from "../../../../actor-store/actor-store-transactor";
import { assertSpice } from "./utils";
import { Exception } from "handlebars";

// <no value>

export default function (server: Server, ctx: AppContext) {
  server.com.atproto.space.createRecord({
    auth: ctx.authVerifier.authorization({
      // @NOTE the "checkTakedown" and "checkDeactivated" checks are typically
      // performed during auth. However, since this method's "repo" parameter
      // can be a handle, we will need to fetch the account again to ensure that
      // the handle matches the DID from the request's credentials. In order to
      // avoid fetching the account twice (during auth, and then again in the
      // controller), the checks are disabled here:

      // checkTakedown: true,
      // checkDeactivated: true,
      authorize: () => {
        // Performed in the handler as it requires the request body
      },
    }),

    rateLimit: [
      {
        name: "repo-write-hour",
        calcKey: ({ auth }) => auth.credentials.did,
        calcPoints: () => 3,
      },
      {
        name: "repo-write-day",
        calcKey: ({ auth }) => auth.credentials.did,
        calcPoints: () => 3,
      },
    ],

    handler: async ({ auth, params, input }) => {
      assertSpice(ctx);

      const label = "createRecord";

      let reqDid: string;
      let reqDidSid: string;
      let repoDid: string;
      let repoDidSid: string;
      let space: string;
      let spaceSid: string;
      let spaceType: string = "invalid";

      try {
        // deconstruct params
        console.log(`${label}.params:`, params);
        // HMMM, why is this one input separate from the rest...?
        //       seems like bad DX imho
        var { collection } = params;

        // deconstruct body
        console.log(`${label}.input:`, input);
        var { parent, record, repo, rkey, validate, zookie } = input.body;

        // validation ... add as needed

        // reject any 'com.atproto.*' NSID
        if (collection?.startsWith("com.atproto")) {
          throw new InvalidRequestError(
            "creating com.atproto records directly is not supported, use the xrpc methods",
          );
        }

        // more validation, DID resolving
        const preflight = await preflightChecks({
          ctx,
          auth,
          // the space we embed in
          repo,
          space: parent,
          collection: collection,
          rkey: rkey,
          record: record,
        });
        reqDid = preflight.reqDid;
        repoDid = preflight.repoDid;
        space = preflight.space;
        rkey = preflight.rkey;

        //
        // check permissions
        //

        // we need to look up the "space" to see if it is a space or bubble
        // you may also want to do the same for any other context that is relevant
        // to the xrpc handler business logic
        var currSpace: any = null;
        await ctx.actorStore.transact(repoDid, async (actorTxn) => {
          const suri = AtUri.make(
            repoDid,
            "com.atproto.space.space",
            "self",
            space,
          );
          currSpace = await actorTxn.space.getRecord(suri, null);
          spaceType = "space";
          if (currSpace === null) {
            const buri = AtUri.make(
              repoDid,
              "com.atproto.space.bubble",
              "self",
              space,
            );
            currSpace = await actorTxn.space.getRecord(buri, null);
            spaceType = "bubble";
          }
        });
        if (currSpace === null) {
          // return error
          // TODO ensure we return similar errors
          throw new InvalidRequestError(
            "unauthenticated, insufficient permissions, or unknown parent",
          );
        }
        console.log("currSpace.space:", JSON.stringify(currSpace, null, "  "));
        const currUri = new AtUri(currSpace.uri);

        // TODO, support more subject kinds, need to base on auth.credentials.type
        let reqSubjectType = "acct";
        reqDidSid = atproto2spicedb(reqDid);
        repoDidSid = atproto2spicedb(repoDid);
        spaceSid = atproto2spicedb(space);

        // what we are checking permission wise? (needs to be set per xrpc handler, perhaps set in the lexicon?)
        // not sure this makes sense as named in the lexicon doc, i.e. group, the objectType is space or bubble
        // can bubble be a boolean on a space, and only different in spicedb?
        // select one of
        // let objectType = "space";
        let objectType = "invalid";
        if (currUri.collection === "com.atproto.space.space") {
          objectType = "space";
        }
        if (currUri.collection === "com.atproto.space.bubble") {
          objectType = "bubble";
        }
        // NOTE, you may need to add more path parts to the resource id, for pretty much
        let objectId = `${repoDidSid}/${spaceSid}`;

        // TODO, caveats for records, but probably only

        await checkPermission({
          spicedbClient: ctx.spicedbClient,
          auth,
          subjectType: reqSubjectType,
          subjectId: reqDidSid,
          permission: "record_create",
          objectType,
          objectId,
          collectionOp: LEX.ids.ComAtprotoSpaceCreateRecord,
          // TODO, pass zookie (and consistency mode?)
          // TODO, pass caveats? (maybe only needed on com.atproto.space.record)
        });
      } catch (err) {
        console.error(err);
        if (
          err instanceof InvalidRecordError ||
          err instanceof InvalidRecordKeyError
        ) {
          throw new InvalidRequestError(
            "unauthenticated, insufficient permissions, or unknown parent",
          );
          // throw new InvalidRequestError(err.message)
        }
        throw err;
      }

      //
      // Prepare operations here
      //

      try {


        // default value(s)
        const rkeySid = atproto2spicedb(rkey as string)

        // main record(s)
        const mainRecord = await prepareCreate({
          reqDid,
          repoDid,
          space,
          collection: collection as string,
          rkey: rkey as string,
          record,
          validate,
        })

        // relation record(s)
        const parentSid = `${spaceType}:${repoDidSid}/${spaceSid}`
        const relation = 'parent'
        const newSpiceID = `record:${repoDidSid}/${spaceSid}/${atproto2spicedb(collection as string)}/${rkeySid}`

        // (owner/parent): prepare a write for the relationship record
        const parentRelation = await prepareCreate({
          reqDid,
          repoDid,
          space: mainRecord.uri.space,
          collection: LEX.ids.ComAtprotoSpaceRelation,
          rkey: ctx.genCuid['16'](),
          record: {
            resource: newSpiceID,
            relation,
            subject: parentSid,
          },
        })

        //
        // DUAL WRITE PROBLEM
        //

        // vars filled during transaction
        var newZookie = "???"
        const status = "???"
        const validationStatus = mainRecord.validationStatus

        // run transaction
        await dualWriteTransaction({
          ctx,
          repo: repoDid,

          // (DWP/1) writes to the repo database
          actorOps: async (actorTxn: ActorStoreTransactor) => {
            // read/write to repo sqlite here

            // main record
            await actorTxn.space.insertRecord({
              uri: mainRecord.uri,
              parent: space,
              record: mainRecord.record,
              reqDid,
            })

            // space -> parent -> record
            await actorTxn.space.insertRecord({
              uri: parentRelation.uri,
              parent: parentRelation.parentUri.toString(),
              record: parentRelation.record,
              reqDid,
            })
          },

          // (DWP/2) writes to the authz service
          authzOps: async (spicedbClient) => {
            // call SpiceDB client here
            const r = await touchRelationship(spicedbClient, newSpiceID, relation, parentSid)
            newZookie = r.writtenAt.token;
          },
        });

        // TODO, (DWP/3) background reconciliation process

        // success!
        const body = {
          cid: mainRecord.cid.toString(),
          status: "ok",
          uri: mainRecord.uri.toString(),
          validationStatus,
          zookie: newZookie,
        };
        console.log("resp.body", JSON.stringify(body, null, "  "));
        return {
          encoding: "application/json",
          body,
        };

      } catch(err: any) {
        console.error(err)
        throw new InternalServerError(err)
      }


    },
  });
}
