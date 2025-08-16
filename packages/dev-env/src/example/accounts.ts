import { AtpAgent } from '@atproto/api'

(async () => {

  // Init the agent
  const agent = new AtpAgent({ service: "http://localhost:2583" })

  const accounts = [
    "alice.test",
    "boris.test",
  ]

  // Create the accounts
  for (const handle of accounts) {
    await agent.createAccount({
      handle,
      email: `${handle}@example.com`,
      password: "hunter2",
    })
  }

  // Print accounts known to the PDS
  const accts = await agent.com.atproto.sync.listRepos({})
  console.log("Accounts:", JSON.stringify(accts.data, null, "  "))

})();

