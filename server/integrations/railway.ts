// Thin Railway GraphQL client. Exists to validate tokens (connect flow) and
// eventually trigger deploys / stream build logs. Deliberately minimal —
// every query/mutation we need gets its own function so the call sites are
// readable and we don't drag in a full GraphQL dependency.
//
// Railway public API reference:
//   https://docs.railway.com/reference/public-api
//   Endpoint: https://backboard.railway.com/graphql/v2
//   Auth: `Authorization: Bearer <personal access token>`

const ENDPOINT = "https://backboard.railway.com/graphql/v2"

export type RailwayMe = {
  id: string
  name: string | null
  email: string | null
  username: string | null
}

export type RailwayProjectSummary = {
  id: string
  name: string
  description: string | null
  createdAt: string
  services: Array<{ id: string; name: string }>
}

export class RailwayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly graphqlErrors?: unknown
  ) {
    super(message)
  }
}

async function gql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (res.status === 401 || res.status === 403) {
    throw new RailwayApiError(
      "Railway rejected the token. Generate a new personal token at railway.com/account/tokens.",
      res.status
    )
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new RailwayApiError(`Railway API ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
  const body = (await res.json()) as { data?: T; errors?: unknown[] }
  if (body.errors?.length) {
    throw new RailwayApiError(
      `Railway API returned errors: ${JSON.stringify(body.errors).slice(0, 300)}`,
      200,
      body.errors
    )
  }
  if (!body.data) {
    throw new RailwayApiError("Railway API returned no data", 200)
  }
  return body.data
}

export async function fetchMe(token: string): Promise<RailwayMe> {
  const data = await gql<{ me: RailwayMe }>(
    token,
    /* GraphQL */ `
      query Me {
        me { id name email username }
      }
    `
  )
  return data.me
}

export async function fetchProjects(token: string): Promise<RailwayProjectSummary[]> {
  const data = await gql<{
    projects: { edges: Array<{ node: RailwayProjectSummary & { services: { edges: Array<{ node: { id: string; name: string } }> } } }> }
  }>(
    token,
    /* GraphQL */ `
      query MyProjects {
        projects {
          edges {
            node {
              id
              name
              description
              createdAt
              services {
                edges { node { id name } }
              }
            }
          }
        }
      }
    `
  )
  return data.projects.edges.map(({ node }) => ({
    id: node.id,
    name: node.name,
    description: node.description,
    createdAt: node.createdAt,
    services: node.services.edges.map((e) => e.node),
  }))
}
