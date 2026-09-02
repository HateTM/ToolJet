function systemPrompt() {
  return `You are an AI assistant specialized in updating ToolJet queries. Your task is to analyze existing query configurations and update specifications, then return ONLY the paths that were modified with their new values. Maintain the exact nesting structure as in the original query. Always return JSON without any additional text or comments.`;
}

function taskPrompt(existingQuery, updateDesign) {
  return `## Task Prompt
  
    ### Input
    Existing Query:
    ${JSON.stringify(existingQuery)}
    
    Update Design:
    ${JSON.stringify(updateDesign)}
    
    You will receive:
    1. **existingQuery**: The current query configuration
    2. **updateDesign**: Design specification defining what needs to be updated
    
    ### Task
    1. **Analyze**: Understand the current structure of the query and the changes requested
    2. **Update**: Make the requested changes internally (don't return full object)
    3. **Return**: Return ONLY the paths that were modified with their new values, preserving the nested structure
    
    ### Understanding Updates
    
    When updating queries, focus on:
    1. **Code modifications**: Changes to the query logic, component references, or data processing
    2. **Parameter updates**: Any changes to query parameters
    3. **Type conversions**: Converting between runjs and runpy if requested
    
    Note: The query name will never change during updates.
    
    ### Reference Syntax Rules (for both runjs and runpy)
    - Component references: Use \`components.component_name.property\` (no \`{{}}\` needed)
    - Query references: Use \`queries.query_name.data\` (no \`{{}}\` needed)
    - Both JavaScript and Python queries use the same reference syntax
    
    ### Response Format
    
    Return ONLY a JSON object containing the modified paths with their new values. Maintain the same nesting structure as in the original query.
    
    Examples:
    
    If only the code changes:
    {
      "options": {
        "code": "// Updated code here"
      }
    }
    
    If converting from runjs to runpy:
    {
      "kind": "runpy",
      "options": {
        "code": "# Updated Python code"
      }
    }
    
    If multiple properties change:
    {
      "kind": "runpy",
      "options": {
        "code": "# Updated Python code",
        "parameters": ["param1", "param2"]
      }
    }
    
    ### Important Rules
    1. Only return properties that actually changed
    2. Maintain the exact nesting structure of the original query
    3. Preserve the formatting and style consistent with the query type
    4. Don't include unchanged properties
    5. When updating code, ensure proper syntax for the target language (JavaScript for runjs, Python for runpy)
    6. Never include the "name" property in the response as it cannot be changed
    
    Return only the JSON object with the modified paths. Do not include any explanatory text before or after the JSON
        Only return the JSON response with the keys above, without any additional text or explanation. Do not include any code blocks or formatting in the response. The response should be a valid JSON object with the specified structure.
    .`;
}

export { systemPrompt, taskPrompt };
