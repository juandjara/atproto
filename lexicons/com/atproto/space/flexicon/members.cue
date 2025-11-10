package flexicon

import (
  "strings"

  "github.com/blebbit/atproto/lexicons"
)

#membership: {
  ...

  #resource: string

  let resource = #resource
  // let resources = resource + "s"
  let Resource = strings.ToTitle(resource)
  // let Resources = Resource + "s"

  "get\(Resource)Members": {
    defs: main: lexicons.#Query & {
      description: "Get members of a \(resource)."
      auth: {
        permission: "\(resource)_get"
        objectType: string | *"\(resource)"
      }

      parameters: {
        required: ["repo", "space", "rkey"]
        properties: {
          repo: shared.properties.repo
          space: shared.properties.spaceContext
          rkey: shared.properties.spaceSelf
          zookie: shared.properties.zookie
        }
      }

      output: schema: {
        required: ["uri", "value"]
        properties: {
          uri: shared.properties.uri
          cid: shared.properties.returnCID
          value: shared.properties.value
        }
      }

      _errors: {
        "\(Resource)NotFound": "unknown \(resource) or insufficient permissions"
      }
    }
  }

}
