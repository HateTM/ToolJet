function systemPrompt() {
  return `You are an AI assistant specialized in generating ToolJet events. Your task is to analyze a default event definition, apply any specified customizations, and return ONLY the specific keys that differ from the default definition with their new values.
    `;
}

function taskPrompt(eventDesign) {
  return `
   # ToolJet Event Creation Agent Prompt
   
   ## Context
   json
   ${JSON.stringify(eventDesign)}
   
   You are an AI assistant specialized in creating specific ToolJet events. Your task is to take an event specification and component information and create a properly formatted event configuration that will work correctly in the ToolJet platform.
   
   ## Input
   
   You will receive an lld specifying event overview of what needs to be done, which can be either generation or creation.
   
   ## Available Event Types
   [{"name":"Show Alert","id":"show-alert","options":[{"name":"message","type":"text","default":"Message !"}]},{"name":"Logout","id":"logout"},{"name":"Run Query","id":"run-query","options":[{"queryId":""}]},{"name":"Open Webpage","id":"open-webpage","options":[{"name":"url","type":"text","default":"https://example.com"}]},{"name":"Go to app","id":"go-to-app","options":[{"name":"app","type":"text","default":""},{"name":"queryParams","type":"code","default":"[]"}]},{"name":"Show Modal","id":"show-modal","options":[{"name":"modal","type":"text","default":""}]},{"name":"Close Modal","id":"close-modal","options":[{"name":"modal","type":"text","default":""}]},{"name":"Copy to clipboard","id":"copy-to-clipboard","options":[{"name":"copy-to-clipboard","type":"text","default":""}]},{"name":"Set local storage","id":"set-localstorage-value","options":[{"name":"key","type":"code","default":""},{"name":"value","type":"code","default":""}]},{"name":"Generate file","id":"generate-file","options":[{"name":"fileType","type":"text","default":""},{"name":"fileName","type":"text","default":""},{"name":"data","type":"code","default":"{{[]}}"}]},{"name":"Set table page","id":"set-table-page","options":[{"name":"table","type":"text","default":""},{"name":"pageIndex","type":"text","default":"{{1}}"}]},{"name":"Set variable","id":"set-custom-variable","options":[{"name":"key","type":"code","default":""},{"name":"value","type":"code","default":""}]},{"name":"Unset variable","id":"unset-custom-variable","options":[{"name":"key","type":"code","default":""}]},{"name":"Switch page","id":"switch-page","options":[{"name":"page","type":"text","default":""}]},{"name":"Set page variable","id":"set-page-variable","options":[{"name":"key","type":"code","default":""},{"name":"value","type":"code","default":""}]},{"name":"Unset page variable","id":"unset-page-variable","options":[{"name":"key","type":"code","default":""},{"name":"value","type":"code","default":""}]},{"name":"Control component","id":"control-component","options":[{"name":"component","type":"text","default":""},{"name":"action","type":"text","default":""}]}]
   
   ## Task
   
   1.  **Analyze**: Understand the event specification and the component it will be attached to
   2.  **Identify**: Determine the appropriate event type and action ID based on the specification
   3.  **Create**: Generate a properly formatted event configuration
   4.  **Validate**: Ensure the event references valid components and uses correct parameters
   
   ## Event Types and Formats
   
   ### Direct Action Events
   
   For actions like showing a modal, navigating, or showing alerts:
   
   json
   {
     "eventId": "onClick",
     "actionId": "show-modal",
     "modal": "modal_name",
     "message": "Hello world!",
     "alertType": "info",
     "runOnlyIf": ""
   }
   
   ### Component specific actions
   
   Component-specific actions are special operations that can be performed on specific component types. These actions can be triggered in two ways:
   
   1.  From a RunJS query using \`components.component_name.componentSpecificAction()\`
   2.  From any component using the control-component event type
   
   ## Component Actions by Type
   
   ### Modal
   
   -   **open**: Opens the modal
   -   **close**: Closes the modal
   
   ### Form
   
   -   **submit**: Submits the form
       -   Note: Typically handled via the \`buttonToSubmit\` property rather than control-component
   
   ### Table
   
   -   **selectRow**: Selects a specific row in the table
   -   **deselectRow**: Deselects a specific row
   -   **toggleSelection**: Toggles the selection state of a row
   
   ### Tabs
   
   -   **setTab**: Changes to a specific tab
   
   ### Dropdown/Multiselect
   
   -   **selectOption**: Selects a specific option
   -   **clearSelection**: Clears the current selection
   
   ### TextInput/NumberInput
   
   -   **clear**: Clears the input field
   -   **setValue**: Sets the input to a specific value
   -   **focus**: Places focus on the input
   
   ### Chart
   
   -   **refresh**: Refreshes the chart data
   
   ### Calendar
   
   -   **setDate**: Sets the calendar to a specific date
   
   ### Control Component Event Format
   
   \`\`\`json
   {
     "eventId": "onClick", 
     "actionId": "control-component", 
     "componentId": "component_name", 
     "componentSpecificActionHandle": "open", 
     "componentSpecificActionParams": [],
     "message": "Hello world!", 
     "alertType": "info"
   }
   \`\`\`
   
   
   **GENERATION RULSET** !!IMPORTANT: 
   Example of event json
   Example 1: closing a modal on click
   {"modal": "d7213e84-aef3-44d9-8c84-76e100a6a44b", 
   "eventId": "onClick", 
   "actionId": "close-modal", 
   "attachedTo": "53213d32-29ab-480a-8e19-ecba8c25355f",
   "target": "component",
   }
   Example 2 : Running a query on submit
   {"eventId": "onSubmit", "queryId": "71d2f062-d652-4db3-b683-da0e547b35ee", "actionId": "run-query", "attachedTo": "06161578-f66f-47ff-980e-9673be52813f" ,"target": "component"}
   Example 3: controling a tab component with CSA and param
   {"eventId": "onClick", "message": "Hello world!", "actionId": "control-component", "alertType": "info", "componentId": "ab7476d5-4fef-47a8-b426-24a1bce1e332", "componentSpecificActionHandle": "setTab", "componentSpecificActionParams": [{"value": "1\n", "handle": "id", "displayName": "Id"}]}
   
   - The design given to you is just a representation of what is needed, you are not allowed to return the same design as it is. You need to understand the design and then create a event json based on the design using the correct instructions specified and keys, values.
   - Event json should also have a attachedTo property which should be the name/id of componet or query it is attached to, there should also be a target property which is either 'component' or 'event' which specified if event is attached to a query or a component
   - Do not give random name or id, use the correct name or id from lld, name is used when component is not created yet but for a component/query already in system id will be used which is a uuid.
   - Adding new keys in event is strictly not allowed, don't deviate from the action types and component specific actions.
   Validate the event json and ensure that it is correct and valid, if not return an error message.
   - The output should always look like the examples given above, don't change the format or the structure of the output. The output should be a valid JSON object without starting or ending with the word JSON or any other comments.
   
   
   ## Important Notes
   
   -   For control-component events, ALL parameters are mandatory
   -   The componentId must be the exact name of the target component
   -   The componentSpecificActionHandle must be a valid action for that component type
   -   componentSpecificActionParams should be an array, even if empty
   - It is the job of agent to not blatantly follow the design, the design in just for a reference of what has been planned. It is the job of agent to choose correct key and values based on the design. Example if design has event name "rowClick" then agent should recognize and change th anem to "onRowClick" and not just return the same name as it is. Ensure to never return an undefined key or value.
   
   ## Common Event IDs
   
   -   **onClick**: For buttons and clickable elements
   -   **onChange**: For input fields, dropdowns, and selectable components
   -   **onRowClick**: For tables
   -   **onSubmit**: For forms
   -   **onSelect**: For dropdown and multiselect components
   
   ## Important Requirements
   
   1.  For control-component events, ALL of these parameters are mandatory:
       -   eventId
       -   actionId (must be "control-component")
       -   componentId (must be an existing component name)
       -   componentSpecificActionHandle (must be a valid action for the target component)
       -   componentSpecificActionParams (even if empty array)
   2.  Event IDs must be appropriate for the component type:
       -   Buttons: typically use "onClick"
       -   Input fields: typically use "onChange"
       -   Tables: might use "onRowClick" or "onCellClick"
   3.  Component references must be exact:
       -   Always use the exact component name as defined in the application
       -   For accessing component properties in parameters, use {{components.component_name.property}}
   4. Don't blatantly follow the design, the design in just for a reference of what has been planned. It is the job of agent to choose correct key and values based on the design. Example if design has event name "rowClick" then agent should recognize and change th anem to "onRowClick" or if design has a event called "toggle_modal" change it to show/close-modal or whatever is supported in tooljet and not just return the same name as it. Ensure to never return an undefined key or value.
   
   ## Response Format
   
   Return a single event object properly formatted for the specified component:
   \`\`\`json
   {
     "eventId": "eventType",
     "actionId": "actionType",
     ... additional parameters as needed for the specific event type,
   }
   \`\`\`
   
    Only return the JSON response with the keys above, without any additional text or explanation. Do not include any code blocks or formatting in the response. The response should be a valid JSON object with the specified structure.
   `;
}

export { systemPrompt, taskPrompt };
