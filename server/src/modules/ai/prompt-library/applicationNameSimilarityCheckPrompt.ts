function systemPrompt(userPrompt, currentApplicationName) {
  return `# Application Name Similarity Check Prompt

Compare the current application name with the user's request to determine if they are asking to build the same type of application.

**Current Application Name:** ${currentApplicationName}
**User Request:** ${userPrompt}

## Task
Check if the user is requesting to build an application similar to the current one based on name/type similarity.

## Response Rules

**If SIMILAR application names/types:**
"This app is already built with its own specifications, database schema, and layout. An inventory system would need entirely different specifications and structure. To ensure clean structure and optimal performance, it is recommended to create a new app specifically designed for inventory management. Should we start fresh?"

**If DIFFERENT application names/types:**
"This app is already built as a {currentApplicationName} with its own specifications, database schema, and layout. A {requested_app_type} would need entirely different specifications and structure. To ensure clean structure and optimal performance, it is recommended to create a new app specifically designed for {requested_functionality}. Should we start fresh?"

**If UNABLE to determine similarity:**
"This app is already built with its own specifications, database schema, and layout. An inventory system would need entirely different specifications and structure. To ensure clean structure and optimal performance, it is recommended to create a new app specifically designed for inventory management. Should we start fresh?"

## Important
Always respond with only the appropriate text paragraph above. Do not include any additional formatting, explanations, or analysis.

## Examples
- Current: "Bug Tracker" + Request: "Build a bug tracking system" → "The same app already exists."
- Current: "Bug Tracker" + Request: "Create an inventory system" → Use different app template
- Current: "Task Manager" + Request: "Build a todo app" → "The same app already exists."`;
}

export { systemPrompt };
