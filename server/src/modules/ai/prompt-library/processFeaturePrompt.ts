export const processfeaturePrompt = (prompt, context) => `
**Role & Task**  
You're a Tooljet app architect expert. Generate a JSON response detailing exact changes needed to implement a requested feature, using ONLY the provided context. Calculate component shifts and layout adjustments. For new generations, use the ruleset to generate new components/events/queries.

**Input Structure**

1.  **Feature Request**: ${prompt}
    
2.  **Context**:
     ${context}
        
3.  **Rules**:
    

**Output Format**
 return json without starting with the word JSON
{
  "component_to_generate": [
    name: {new component }
  ],
  "component_to_update":{
  id1: {Updated keys}
  },
  "query_to_generate": [
	 name: {new quero}
  ],
  "query_to_update": [
    id: {query update keys}
  ],
  "event_to_generate": [
    {
      "name": "string",
      "component": "string",
      "action": {},
      "eventId": "string"
    }
  ],
  "event_to_update": [
   id: {updates}
  ]
}

**Critical Requirements**

1.  Never invent components/queries/events beyond provided context
    
2.  For updates, ONLY show modified fields (never repeat unchanged values)
    
3.  Explicitly calculate new grid positions when adding/moving components
    
4.  Maintain parent-child relationships in component hierarchy
    
5.  Preserve existing event chains unless directly impacted.

 # New component/event/query generation ruleset 

  

## CORE PRINCIPLES

  

1. **Unique Naming**: Use \`[role]_[type]_[purpose]\` pattern (e.g., employee-form-startdate). NO duplicate component names allowed under ANY circumstance.

  

2. **Nesting Structure**: Follow hierarchy: Root → Tab → Container → Components (maximum 2 levels deep). For nesting, set the \`parent\` property of component to the parent component name. Container and tabs can be used for nesting. For tabs, direct children should have parent property set to \`tabName-tabId\` where tabId is the specific tab's ID.

Ex if tab has name main_tab and has 3 tabs with id "tab1", "tab2" and "tab3" then the children of tab1 should have parent property set to \`main_tab-tab1\` and so on.

  

3. **Data Binding**: Components can be referenced using {{components.componentName.property}} and queries using {{queries.queryName.data}}. A component can reference other components or queries and query can reference other query data("{{queries.queryName.data}}") or component properties as well.

  

4. **Layout Specifications**: For every component, generate layout JSON with:

- \`left\`: position on x-axis (1-40)

- \`top\`: position on y-axis (5-970 pixels)

- \`width\`: component width (1-40, ensure left+width ≤ 42)

- \`height\`: component height in pixels (ensure top+height ≤ 1000)

- Child components inside containers restart grid from 0-40

- Tabs should have fixed layout: {height: 950, width: 41, top: 90, left: 1}

- return the layout as an array of 4 values arr[0]=top, arr[1]=left, arr[2]=width, arr[3]=height

- Ensure all first level children take up the full width of parent but there shuold be a small padding. Ex if a tab width is x then a container in tab will be x-somepadding, or if a modal has a form, or a container the container or form will take up the full width of modal minus some padding.

- Ensure multiple checks in layout to avoid voids or whitespaces in the UI

  

5. **Component Limits**:

- Ensure no form component is every empty, every form must have some inputs.

-Ensure the LLD contains no more than 50 core components. Core components include components like modal, table, dropdowns, and forms. Buttons, icons, and other UI elements that are not core components should not be counted in this limit. This is to ensure that the LLD remains manageable and focused on the essential components needed for the application.

  

6. **Special rules**

- some components might have special rules which are specified and explained in the component specifications.

  

## COMPONENT SPECIFICATIONS

  

### Button

{"buttonConfig":{"name":"Button","defaultSize":{"width":4,"height":40},"properties":{"text":{"validation":{"schema":{"type":"string"}}},"loadingState":{"validation":{"schema":{"type":"boolean"}}},"visibility":{"validation":{"schema":{"type":"boolean"}}},"disabledState":{"validation":{"schema":{"type":"boolean"}}},"tooltip":{"validation":{"schema":{"type":"string"}}}},"events":{"onClick":{"displayName":"On click"},"onHover":{"displayName":"On hover"}},"styles":{"type":{"validation":{"schema":{"type":"string"}},"options":[{"displayName":"Solid","value":"primary"},{"displayName":"Outline","value":"outline"}]},"backgroundColor":{"validation":{"schema":{"type":"string"},"defaultValue":false}},"textColor":{"validation":{"schema":{"type":"string"},"defaultValue":false}},"borderColor":{"validation":{"schema":{"type":"string"},"defaultValue":false}},"loaderColor":{"validation":{"schema":{"type":"string"},"defaultValue":false}},"borderRadius":{"validation":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}},"defaultValue":false}},"boxShadow":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}}}},"actions":[{"handle":"click"},{"handle":"setText","params":[{"handle":"text","displayName":"Text","defaultValue":"New Text"}]},{"handle":"setVisibility","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setLoading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"disable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"visibility","params":[{"handle":"visible","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"loading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"text":{"value":"Button"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"tooltip":{"value":""}},"events":[],"styles":{"textColor":{"value":"#FFFFFF"},"borderColor":{"value":"#4368E3"},"loaderColor":{"value":"#FFFFFF"},"borderRadius":{"value":"{{6}}"},"backgroundColor":{"value":"#4368E3"},"iconColor":{"value":"#FFFFFF"},"direction":{"value":"left"},"padding":{"value":"default"},"boxShadow":{"value":"0px 0px 0px 0px #00000090"},"icon":{"value":"IconAlignBoxBottomLeft"},"iconVisibility":{"value":false},"type":{"value":"primary"}}}}}

  

### Datepicker

{"datepickerConfig":{"name":"Datepicker","defaultSize":{"width":5,"height":30},"validation":{"customRule":{"type":"code","displayName":"Custom validation"}},"others":{"showOnDesktop":{"type":"toggle","displayName":"Show on desktop"},"showOnMobile":{"type":"toggle","displayName":"Show on mobile"}},"properties":{"defaultValue":{"validation":{"schema":{"type":"string"},"defaultValue":"01/01/2022"}},"format":{"validation":{"schema":{"type":"string"},"defaultValue":"DD/MM/YYYY"}},"enableTime":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"enableDate":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledDates":{"validation":{"schema":{"type":"array","element":{"type":"string"}},"defaultValue":"['01/01/2022']"}}},"events":{"onSelect":{"displayName":"On select"}},"styles":{"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"borderRadius":{"validation":{"schema":{"type":"number"},"defaultValue":4}}},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"validation":{"customRule":{"value":""}},"properties":{"defaultValue":{"value":"01/01/2022"},"format":{"value":"DD/MM/YYYY"},"enableTime":{"value":"{{false}}"},"enableDate":{"value":"{{true}}"},"disabledDates":{"value":"{{[]}}"}},"events":[],"styles":{"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"borderRadius":{"value":"{{4}}"}}}}}

  

### Checkbox

{"checkboxConfig":{"name":"Checkbox","defaultSize":{"width":6,"height":30},"properties":{"label":{"validation":{"schema":{"type":"string"}}},"defaultValue":{"validation":{"schema":{"type":"boolean"}},"options":[{"displayName":"On","value":"{{true}}"},{"displayName":"Off","value":"{{false}}"}],"accordian":"label"},"loadingState":{"validation":{"schema":{"type":"boolean"}},"section":"additionalActions"},"visibility":{"validation":{"schema":{"type":"boolean"}},"section":"additionalActions"},"disabledState":{"validation":{"schema":{"type":"boolean"}},"section":"additionalActions"},"tooltip":{"validation":{"schema":{"type":"string"}},"section":"additionalActions","placeholder":"Enter tooltip text"}},"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"events":{"onChange":{"displayName":"On change"},"onCheck":{"displayName":"On check (Deprecated)"},"onUnCheck":{"displayName":"On uncheck (Deprecated)"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}},"accordian":"switch"}},"actions":[{"handle":"toggle","displayName":"toggle"},{"handle":"setValue","displayName":"Set value","params":[{"handle":"value","displayName":"value"}]},{"handle":"setVisibility","displayName":"Set visibility","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","displayName":"Set disable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setLoading","displayName":"Set loading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setChecked","displayName":"Set checked (Deprecated)","params":[{"handle":"status","displayName":"status"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"label":{"value":"Label"},"defaultValue":{"value":"{{false}}"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"tooltip":{"value":""}},"events":[],"styles":{"boxShadow":{"value":"0px 0px 0px 0px #00000090"}},"validation":{"mandatory":{"value":"{{false}}"},"customRule":{"value":null}}}}}

  

### Calendar

{"calendarConfig":{"name":"Calendar","defaultSize":{"width":30,"height":600},"properties":{"dateFormat":{"type":"code","displayName":"Date format"},"defaultDate":{"type":"code","displayName":"Default date"},"events":{"type":"code","displayName":"Events"},"defaultView":{"type":"code","displayName":"Default view"},"startTime":{"type":"code","displayName":"Start time on week and day view"},"endTime":{"type":"code","displayName":"End time on week and day view"},"displayToolbar":{"type":"toggle","displayName":"Show toolbar"},"displayViewSwitcher":{"type":"toggle","displayName":"Show view switcher"},"highlightToday":{"type":"toggle","displayName":"Highlight today"},"showPopOverOnEventClick":{"type":"toggle","displayName":"Show popover when event is clicked"}},"events":{"onCalendarEventSelect":{"displayName":"On Event Select"},"onCalendarSlotSelect":{"displayName":"On Slot Select"},"onCalendarNavigate":{"displayName":"On Date Navigate"},"onCalendarViewChange":{"displayName":"On View Change"}},"styles":{"visibility":{"type":"toggle","displayName":"Visibility"},"weekDateFormat":{"type":"code","displayName":"Header date format on week view"}},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"dateFormat":{"value":"MM-DD-YYYY HH:mm:ss A Z"},"defaultDate":{"value":"{{moment().format("MM-DD-YYYY HH:mm:ss A Z")}}"},"events":{"value":"{{[\n\t\t{\n\t\t\t title: 'Sample event',\n\t\t\t start: \`\${moment().startOf('day').format('MM-DD-YYYY HH:mm:ss A Z')}\`,\n\t\t\t end: \`\${moment().endOf('day').format('MM-DD-YYYY HH:mm:ss A Z')}\`,\n\t\t\t allDay: false,\n\t\t\t color: '#4D72DA'\n\t\t}\n]}}"},"resources":{"value":"{{[]}}"},"defaultView":{"value":"{{'month'}}"},"startTime":{"value":"{{moment().startOf('day').format('MM-DD-YYYY HH:mm:ss A Z')}}"},"endTime":{"value":"{{moment().endOf('day').format('MM-DD-YYYY HH:mm:ss A Z')}}"},"displayToolbar":{"value":true},"displayViewSwitcher":{"value":true},"highlightToday":{"value":true},"showPopOverOnEventClick":{"value":false}},"events":[],"styles":{"visibility":{"value":"{{true}}"},"weekDateFormat":{"value":"DD MMM"}}}}}

  

### Chart

{"chartConfig":{"name":"Chart","defaultSize":{"width":20,"height":400},"properties":{"title":{"validation":{"schema":{"type":"string"}}},"data":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"array"}]},"defaultValue":""}},"loadingState":{"validation":{"schema":{"type":"boolean"}}},"type":{"type":"select","displayName":"Chart type","options":[{"name":"Line","value":"line"},{"name":"Bar","value":"bar"},{"name":"Pie","value":"pie"}],"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"boolean"},{"type":"number"}]},"defaultValue":"line"}},"barmode":{"options":[{"name":"Stack","value":"stack"},{"name":"Group","value":"group"},{"name":"Overlay","value":"overlay"},{"name":"Relative","value":"relative"}],"validation":{"schema":{"schemas":{"type":"string"}}}}},"actions":[{"handle":"clearClickedPoint","displayName":"Clear clicked point"}],"events":{"onClick":{"displayName":"On data point click"},"onDoubleClick":{"displayName":"On double click"}},"styles":{"visibility":{"type":"toggle","displayName":"Visibility","validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"type":"toggle","displayName":"Disable","validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"title":{"value":"This title can be changed"},"markerColor":{"value":"#CDE1F8"},"showAxes":{"value":"{{true}}"},"showGridLines":{"value":"{{true}}"},"loadingState":{"value":"{{false}}"},"barmode":{"value":"group"},"type":{"value":"line"},"data":{"value":"[\n { "x": "Jan", "y": 100},\n { "x": "Feb", "y": 80},\n { "x": "Mar", "y": 40}\n ]"}},"events":[],"styles":{"backgroundColor":{"value":"#fff"},"padding":{"value":"50"},"borderRadius":{"value":"{{4}}"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"}}}}}

  

### DateRangePicker

{"daterangepickerConfig":{"name":"DateRangePicker","defaultSize":{"width":10,"height":30},"properties":{"defaultStartDate":{"validation":{"schema":{"type":"string"},"defautlValue":"01/04/2022"}},"defaultEndDate":{"validation":{"schema":{"type":"string"},"defautlValue":"10/04/2022"}},"format":{"validation":{"schema":{"type":"string"},"defautlValue":"DD/MM/YYYY"}}},"events":{"onSelect":{"displayName":"On select"}},"styles":{"visibility":{"type":"toggle","displayName":"Visibility","validation":{"schema":{"type":"boolean"},"defautlValue":true}},"disabledState":{"type":"toggle","displayName":"Disable","validation":{"schema":{"type":"boolean"},"defautlValue":false}}},"exposedVariables":{"endDate":{},"startDate":{}},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"defaultStartDate":{"value":"01/04/2022"},"defaultEndDate":{"value":"10/04/2022"},"format":{"value":"DD/MM/YYYY"}},"events":[],"styles":{"borderRadius":{"value":"4"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"}}}}}

  

### Divider

{"dividerConfig":{"name":"Divider","defaultSize":{"width":10,"height":10},"properties":{},"events":{},"styles":{"dividerColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#000000"}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}}},"exposedVariables":{"value":{}},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{},"events":[],"styles":{"visibility":{"value":"{{true}}"},"dividerColor":{"value":"#000000"}}}}}

  

### Container

{"containerConfig":{"name":"Container","defaultSize":{"width":5,"height":200},"properties":{"loadingState":{"type":"toggle","displayName":"Loading state","validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"events":{},"styles":{"backgroundColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#fff"}},"borderColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#fff"}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"}},"defaultValue":false}},"exposedVariables":{},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"visible":{"value":"{{true}}"},"loadingState":{"value":"{{false}}"}},"events":[],"styles":{"backgroundColor":{"value":"#fff"},"borderColor":{"value":"#fff"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"}}}}}

  

### Dropdown

{"dropdownV2Config":{"name":"Dropdown","defaultSize":{"width":10,"height":40},"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"component":"DropdownV2","properties":{"label":{"validation":{"schema":{"type":"string"},"defaultValue":"Select"}},"placeholder":{"validation":{"schema":{"type":"string"},"defaultValue":"Select an option"}},"optionsLoadingState":{"validation":{"schema":{"type":"boolean"}}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"tooltip":{"validation":{"schema":{"type":"string"},"defaultValue":"Enter tooltip text"}}},"events":{"onSelect":{"displayName":"On select"},"onSearchTextChanged":{"displayName":"On search text changed"},"onFocus":{"displayName":"On focus"},"onBlur":{"displayName":"On blur"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":"0px 0px 0px 0px #00000040"},"accordian":"field"}},"actions":[{"handle":"selectOption","displayName":"Select option","params":[{"handle":"select","displayName":"Select"}]},{"handle":"setVisibility","displayName":"Set visibility","params":[{"handle":"setVisibility","displayName":"Value","defaultValue":"{{true}}","type":"toggle"}]},{"handle":"clear","displayName":"Clear"},{"handle":"setLoading","displayName":"Set loading","params":[{"handle":"setLoading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","displayName":"Set disable","params":[{"handle":"setDisable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"definition":{"validation":{"mandatory":{"value":"{{false}}"},"customRule":{"value":null}},"properties":{"options":{"value":[{"label":"option1","value":"1","disable":{"value":false},"visible":{"value":true},"default":{"value":false}},{"label":"option2","value":"2","disable":{"value":false},"visible":{"value":true},"default":{"value":true}},{"label":"option3","value":"3","disable":{"value":false},"visible":{"value":true},"default":{"value":false}}]},"label":{"value":"Select"},"optionsLoadingState":{"value":"{{false}}"},"placeholder":{"value":"Select an option"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"tooltip":{"value":""}},"events":[],"styles":{"boxShadow":{"value":"0px 0px 0px 0px #00000090"}}}}}

- !Special comment for dropdown

- Always have advanced property set to {{false}}, this is a mandatory property and should be added in the output.

- set property.adavanced to {{false}} in the output.

  

### Icon

{"iconConfig":{"name":"Icon","defaultSize":{"width":5,"height":48},"properties":{"icon":{"validation":{"schema":{"type":"string"},"defaultValue":"IconHome2"}}},"events":{"onClick":{"displayName":"On click"},"onHover":{"displayName":"On hover"}},"styles":{"iconColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#000"}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}}},"exposedVariables":{},"actions":[{"handle":"click","displayName":"Click"},{"displayName":"Set Visibility","handle":"setVisibility","params":[{"handle":"value","displayName":"Value","defaultValue":"{{true}}","type":"toggle"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"icon":{"value":"IconHome2"}},"events":[],"styles":{"iconColor":{"value":"#000"},"visibility":{"value":"{{true}}"}}}}}

  

### Image

{"imageConfig":{"name":"Image","defaultSize":{"width":3,"height":100},"properties":{"source":{"validation":{"schema":{"type":"string"},"defaultValue":"https://www.svgrepo.com/image.svg"}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"alternativeText":{"validation":{"schema":{"type":"string"},"defaultValue":"this is an image"}},"zoomButtons":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"rotateButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"events":{"onClick":{"displayName":"On click"}},"styles":{"borderType":{"options":[{"name":"None","value":"none"},{"name":"Rounded","value":"rounded"},{"name":"Circle","value":"rounded-circle"},{"name":"Thumbnail","value":"img-thumbnail"}],"validation":{"schema":{"type":"string"},"defaultValue":"none"}},"backgroundColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#ffffff"}},"padding":{"validation":{"schema":{"type":"number"},"defaultValue":0}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"imageFit":{"options":[{"name":"fill","value":"fill"},{"name":"contain","value":"contain"},{"name":"cover","value":"cover"},{"name":"scale-down","value":"scale-down"}],"validation":{"schema":{"type":"string"},"defaultValue":"contain"}}},"exposedVariables":{},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"source":{"value":"https://www.svgrepo.com/show/34217/image.svg"},"visible":{"value":"{{true}}"},"loadingState":{"value":"{{false}}"},"alternativeText":{"value":""},"zoomButtons":{"value":"{{false}}"},"rotateButton":{"value":"{{false}}"}},"events":[],"styles":{"borderType":{"value":"none"},"padding":{"value":"0"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"imageFit":{"value":"contain"},"backgroundColor":{"value":""}}}}}

  

### Form

{"formConfig":{"name":"Form","defaultSize":{"width":13,"height":330},"properties":{"buttonToSubmit":{"validation":{"schema":{"type":"string"},"defaultValue":"none"}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"events":{"onSubmit":{"displayName":"On submit"},"onInvalid":{"displayName":"On invalid"}},"styles":{"visibility":{"type":"toggle","displayName":"Visibility","validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"type":"toggle","displayName":"Disable","validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"exposedVariables":{"data":{},"isValid":true},"actions":[{"handle":"submitForm","displayName":"Submit Form"},{"handle":"resetForm","displayName":"Reset Form"}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"loadingState":{"value":"{{false}}"}},"events":[],"styles":{"backgroundColor":{"value":"#fff"},"borderColor":{"value":"#fff"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"}}}}}

*Special instruction for form*

- the buttonToSubmit property in form is used to set the button which will be used to submit the form. The value of this property should be name of button used to submit the form. Instead of using control component on a button, use buttonToSubmit property to submit the form.

- Always ensure that a form is never empty and has some input components inside it. If a form is empty, then the form will not be created.

  

### Modal

{"modalConfig":{"name":"Modal","defaultSize":{"width":10,"height":34},"properties":{"title":{"validation":{"schema":{"type":"string"},"defaultValue":"This title can be changed"}},"titleAlignment":{"options":[{"name":"left","value":"left"},{"name":"center","value":"center"},{"name":"right","value":"right"}],"validation":{"schema":{"type":"string"},"defaultValue":"left"}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"useDefaultButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"triggerButtonLabel":{"validation":{"schema":{"type":"string"},"defaultValue":"Launch Modal"}},"hideTitleBar":{"type":"toggle","displayName":"Hide title bar"},"hideCloseButton":{"type":"toggle","displayName":"Hide close button"},"hideOnEsc":{"type":"toggle","displayName":"Close on escape key"},"closeOnClickingOutside":{"type":"toggle","displayName":"Close on clicking outside"},"size":{"options":[{"name":"small","value":"sm"},{"name":"medium","value":"lg"},{"name":"large","value":"xl"}],"validation":{"schema":{"type":"string"},"defaultValue":"lg"}},"modalHeight":{"validation":{"schema":{"type":"string"},"defaultValue":"400px"}}},"events":{"onOpen":{"displayName":"On open"},"onClose":{"displayName":"On close"}},"styles":{"headerBackgroundColor":{"type":"color","displayName":"Header background color","validation":{"schema":{"type":"string"},"defaultValue":"#ffffffff"}},"headerTextColor":{"type":"color","displayName":"Header title color","validation":{"schema":{"type":"string"},"defaultValue":"#000000"}},"bodyBackgroundColor":{"type":"color","displayName":"Body background color","validation":{"schema":{"type":"string"},"defaultValue":"#ffffffff"}},"disabledState":{"type":"toggle","displayName":"Disable","validation":{"schema":{"type":"boolean"},"defaultValue":false}},"visibility":{"type":"toggle","displayName":"Visibility","validation":{"schema":{"type":"boolean"},"defaultValue":true}},"triggerButtonBackgroundColor":{"type":"color","displayName":"Trigger button background color","validation":{"schema":{"type":"string"},"defaultValue":false}},"triggerButtonTextColor":{"type":"color","displayName":"Trigger button text color","validation":{"schema":{"type":"string"},"defaultValue":false}}},"actions":[{"handle":"open","displayName":"Open"},{"handle":"close","displayName":"Close"}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"title":{"value":"This title can be changed"},"titleAlignment":{"value":"left"},"loadingState":{"value":"{{false}}"},"useDefaultButton":{"value":"{{true}}"},"triggerButtonLabel":{"value":"Launch Modal"},"size":{"value":"lg"},"hideTitleBar":{"value":"{{false}}"},"hideCloseButton":{"value":"{{false}}"},"hideOnEsc":{"value":"{{true}}"},"closeOnClickingOutside":{"value":"{{false}}"},"modalHeight":{"value":"400px"}},"events":[],"styles":{"headerBackgroundColor":{"value":"#ffffffff"},"headerTextColor":{"value":"#000000"},"bodyBackgroundColor":{"value":"#ffffffff"},"disabledState":{"value":"{{false}}"},"visibility":{"value":"{{true}}"},"triggerButtonBackgroundColor":{"value":"#4D72FA"},"triggerButtonTextColor":{"value":"#ffffffff"}}}}}

- !Special comment for modal

1. The height and width is modal layout is not for the actual modal but instead for the modal trigger button.

2. If useDefaultButton is true, then the modal trigger button will be created with the default size of a button .

3. If useDefaultButton is false, then the height and width in layout will be zero.

  

### Multiselect

{"multiselectV2Config":{"name":"Multiselect","defaultSize":{"width":10,"height":40},"component":"MultiselectV2","actions":[{"handle":"selectOptions","params":[{"handle":"option","displayName":"Option"}]},{"handle":"deselectOptions","params":[{"handle":"option","displayName":"Option"}]},{"handle":"clear"},{"handle":"setVisibility","params":[{"handle":"setVisibility","displayName":"Value","defaultValue":"{{true}}","type":"toggle"}]},{"handle":"setLoading","params":[{"handle":"setLoading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","params":[{"handle":"setDisable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"properties":{"label":{"validation":{"schema":{"type":"string"},"defaultValue":"Label"}},"placeholder":{"validation":{"schema":{"type":"string"},"defaultValue":"Select the options"}},"value":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"},{"type":"boolean"}]}}},"showAllOption":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"optionsLoadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"tooltip":{"validation":{"schema":{"type":"string"},"defaultValue":""}}},"events":{"onSelect":{"displayName":"On select"},"onSearchTextChanged":{"displayName":"On search text changed"},"onFocus":{"displayName":"On focus"},"onBlur":{"displayName":"On blur"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box Shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":"0px 0px 0px 0px #00000090"},"accordian":"field"}},"definition":{"validation":{"mandatory":{"value":false},"customRule":{"value":null}},"properties":{"label":{"value":"Select"},"values":{"value":["1","2"]},"showAllOption":{"value":"{{false}}"},"optionsLoadingState":{"value":"{{false}}"},"placeholder":{"value":"Select the options"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"options":{"value":[{"label":"option1","value":"1","disable":{"value":false},"visible":{"value":true},"default":{"value":false}},{"label":"option2","value":"2","disable":{"value":false},"visible":{"value":true},"default":{"value":true}},{"label":"option3","value":"3","disable":{"value":false},"visible":{"value":true},"default":{"value":false}}]},"tooltip":{"value":""}},"events":[],"styles":{"boxShadow":{"value":"0px 0px 0px 0px #00000090"}}}}}

  

### NumberInput

{"numberinputConfig":{"name":"NumberInput","defaultSize":{"width":10,"height":40},"properties":{"label":{"validation":{"schema":{"type":"string"},"defaultValue":"Label"}},"value":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":0}},"placeholder":{"validation":{"schema":{"type":"string"},"defaultValue":"Enter your input"}},"decimalPlaces":{"validation":{"schema":{"type":"number"},"defaultValue":2}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"tooltip":{"validation":{"schema":{"type":"string"},"defaultValue":"Tooltip text"}}},"events":{"onChange":{"displayName":"On change"},"onFocus":{"displayName":"On focus"},"onBlur":{"displayName":"On blur"},"onEnterPressed":{"displayName":"On enter pressed"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box Shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":"0px 0px 0px 0px #00000040"},"accordian":"field"}},"actions":[{"handle":"setText","displayName":"Set text","params":[{"handle":"text","displayName":"text","defaultValue":"100"}]},{"handle":"clear","displayName":"Clear"},{"handle":"setFocus","displayName":"Set focus"},{"handle":"setBlur","displayName":"Set blur"},{"handle":"setVisibility","displayName":"Set visibility","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","displayName":"Set disable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setLoading","displayName":"Set loading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"regex":{"type":"code","displayName":"Regex","placeholder":"^d+$"},"minValue":{"type":"code","displayName":"Min value","placeholder":"Enter min value"},"maxValue":{"type":"code","displayName":"Max value","placeholder":"Enter max value"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"definition":{"validation":{"mandatory":{"value":"{{false}}"},"regex":{"value":""},"minValue":{"value":""},"maxValue":{"value":""},"customRule":{"value":""}},"properties":{"value":{"value":"0"},"label":{"value":"Label"},"maxValue":{"value":""},"minValue":{"value":""},"placeholder":{"value":"0"},"decimalPlaces":{"value":"{{2}}"},"tooltip":{"value":""},"visibility":{"value":"{{true}}"},"loadingState":{"value":"{{false}}"},"disabledState":{"value":"{{false}}"}},"events":[],"styles":{"boxShadow":{"value":"0px 0px 0px 0px #00000040"}}}}}

  

### RadioButton

{"radiobuttonConfig":{"name":"RadioButton","defaultSize":{"width":6,"height":60},"properties":{"label":{"validation":{"schema":{"type":"string"},"defaultValue":"Select"}},"value":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"},{"type":"boolean"}]},"defaultValue":true}},"values":{"validation":{"schema":{"type":"array","element":{"type":"union","schemas":[{"type":"string"},{"type":"number"},{"type":"boolean"}]}},"defaultValue":[true,false]}},"display_values":{"validation":{"schema":{"type":"array","element":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}},"defaultValue":["yes","no"]}}},"events":{"onSelectionChange":{"displayName":"On select"}},"styles":{"textColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#000000"}},"activeColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#000000"}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"actions":[{"handle":"selectOption","displayName":"Select Option","params":[{"handle":"option","displayName":"Option"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"label":{"value":"Select"},"value":{"value":"{{true}}"},"values":{"value":"{{[true,false]}}"},"display_values":{"value":"{{["yes", "no"]}}"},"visible":{"value":"{{true}}"}},"events":[],"styles":{"textColor":{"value":""},"activeColor":{"value":""},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"}}}}}

  

### PasswordInput

{"passinputConfig":{"name":"PasswordInput","defaultSize":{"width":10,"height":40},"properties":{"label":{"validation":{"schema":{"type":"string"},"defaultValue":"Label"}},"placeholder":{"validation":{"schema":{"type":"string"},"defaultValue":"Password"}},"value":{"validation":{"schema":{"type":"string"},"defaultValue":"default value"}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"tooltip":{"validation":{"schema":{"type":"string"},"defaultValue":"Tooltip text"}}},"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"regex":{"type":"code","displayName":"Regex","placeholder":"^(?=.*[a-z])(?=.*[A-Z])(?=.*d)[a-zA-Zd]{8,}$"},"minLength":{"type":"code","displayName":"Min length","placeholder":"Enter min length"},"maxLength":{"type":"code","displayName":"Max length","placeholder":"Enter max length"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"events":{"onChange":{"displayName":"On change"},"onFocus":{"displayName":"On focus"},"onBlur":{"displayName":"On blur"},"onEnterPressed":{"displayName":"On enter pressed"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":"0px 0px 0px 0px #00000040"},"accordian":"field"}},"exposedVariables":{"value":"","isMandatory":false,"isVisible":true,"isDisabled":false,"isLoading":false},"actions":[{"handle":"setText","displayName":"Set text","params":[{"handle":"text","displayName":"text","defaultValue":"New Text"}]},{"handle":"clear","displayName":"Clear"},{"handle":"setFocus","displayName":"Set focus"},{"handle":"setBlur","displayName":"Set blur"},{"handle":"setVisibility","displayName":"Set visibility","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","displayName":"Set disable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setLoading","displayName":"Set loading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"placeholder":{"value":"Password"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"tooltip":{"value":""},"label":{"value":"Label"},"value":{"value":""}},"validation":{"mandatory":{"value":false},"regex":{"value":""},"minLength":{"value":""},"maxLength":{"value":""},"customRule":{"value":""}},"events":[],"styles":{"boxShadow":{"value":"0px 0px 0px 0px #00000040"}}}}}

  

### Spinner

{"spinnerConfig":{"name":"Spinner","defaultSize":{"width":4,"height":30},"properties":{},"events":{},"styles":{"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"colour":{"validation":{"schema":{"type":"string"},"defaultValue":"#0565ff"}},"size":{"options":[{"name":"small","value":"sm"},{"name":"large","value":"lg"}],"validation":{"schema":{"type":"string"},"defaultValue":"sm"}}},"exposedVariables":{},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{},"events":[],"styles":{"visibility":{"value":"{{true}}"},"size":{"value":"sm"},"colour":{"value":"#0565ff"}}}}}

  

### Statistics

{"statisticsConfig":{"name":"Statistics","defaultSize":{"width":9,"height":152},"properties":{"primaryValueLabel":{"validation":{"schema":{"type":"string"},"defaultValue":"This months earnings"}},"primaryValue":{"validation":{"schema":{"type":"string"},"defaultValue":"682.3"}},"hideSecondary":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"secondaryValueLabel":{"validation":{"schema":{"type":"string"},"defaultValue":"Last month"}},"secondaryValue":{"validation":{"schema":{"type":"string"},"defaultValue":"2.85"}},"secondarySignDisplay":{"validation":{"schema":{"type":"string"},"defaultValue":"positive"}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"styles":{"primaryLabelColour":{"validation":{"schema":{"type":"string"},"defaultValue":"#8092AB"}},"primaryTextColour":{"validation":{"schema":{"type":"string"},"defaultValue":"#000000"}},"secondaryLabelColour":{"validation":{"schema":{"type":"string"},"defaultValue":"#8092AB"}},"secondaryTextColour":{"validation":{"schema":{"type":"string"},"defaultValue":"#36AF8B"}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}}},"definition":{"properties":{"primaryValueLabel":{"value":"This months earnings"},"primaryValue":{"value":"682.3"},"secondaryValueLabel":{"value":"Last month"},"secondaryValue":{"value":"2.85"},"secondarySignDisplay":{"value":"positive"},"loadingState":{"value":"{{false}}"}},"events":[],"styles":{"primaryLabelColour":{"value":"#8092AB"},"primaryTextColour":{"value":"#000000"},"secondaryLabelColour":{"value":"#8092AB"},"secondaryTextColour":{"value":"#36AF8B"},"visibility":{"value":"{{true}}"}}}}}

  

### Tabs

{"tabsConfig":{"name":"Tabs","defaultSize":{"width":30,"height":300},"properties":{"tabs":{"validation":{"schema":{"type":"array","element":{"type":"object","object":{"id":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}}}},"defaultValue":[{"title":"Home","id":"0"},{"title":"Profile","id":"1"},{"title":"Settings","id":"2"}]}},"defaultTab":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":"0"}},"hideTabs":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"renderOnlyActiveTab":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}}},"events":{"onTabSwitch":{"displayName":"On tab switch"}},"actions":[{"handle":"setTab","displayName":"Set current tab","params":[{"handle":"id","displayName":"Id"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"tabs":{"value":"{{[ \n\t\t{ title: 'Home', id: '0' }, \n\t\t{ title: 'Profile', id: '1' }, \n\t\t{ title: 'Settings', id: '2' } \n ]}}"},"defaultTab":{"value":"0"},"hideTabs":{"value":false},"renderOnlyActiveTab":{"value":false}},"events":[]}}}

  

### Table

{"tableConfig":{"name":"Table","properties":{"title":{"validation":{"schema":{"type":"string"}}},"data":{"validation":{"schema":{"type":"array","element":{"type":"object"}}}},"loadingState":{"validation":{"schema":{"type":"boolean"}}},"useDynamicColumn":{"type":"toggle","displayName":"Use dynamic column","validation":{"schema":{"type":"boolean"}}},"columnData":{"validation":{"schema":{"type":"array","element":{"type":"object"}},"defaultValue":"{{[{name: 'email', key: 'email', id: '1'}, {name: 'Full name', key: 'name', id: '2', isEditable: true}]}}}"}},"rowsPerPage":{"validation":{"schema":{"type":"number"},"defaultValue":10}},"enableNextButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"enabledSort":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"hideColumnSelectorButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"enablePrevButton":{"validation":{"schema":{"type":"boolean"}}},"totalRecords":{"validation":{"schema":{"type":"number"},"defaultValue":10}},"enablePagination":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"displaySearchBox":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"showDownloadButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"showFilterButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"showBulkUpdateActions":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"allowSelection":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"showBulkSelector":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"highlightSelectedRow":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"defaultSelectedRow":{"validation":{"schema":{"type":"object"},"defaultValue":{"id":1}}},"showAddNewRowButton":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"selectRowOnCellEdit":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"visibility":{"validation":{"schema":{"type":"boolean"}}},"disabledState":{"validation":{"schema":{"type":"boolean"}}}},"defaultSize":{"width":35,"height":456},"events":{"onRowHovered":{"displayName":"Row hovered"},"onRowClicked":{"displayName":"Row clicked"},"onBulkUpdate":{"displayName":"Save changes"},"onPageChanged":{"displayName":"Page changed"},"onSearch":{"displayName":"Search"},"onCancelChanges":{"displayName":"Cancel changes"},"onSort":{"displayName":"Sort applied"},"onCellValueChanged":{"displayName":"Cell value changed"},"onFilterChanged":{"displayName":"Filter changed"},"onNewRowsAdded":{"displayName":"Add new rows"}},"styles":{"textColor":{"validation":{"schema":{"type":"string"},"defaultValue":"#000"}},"boxShadow":{"validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}}}},"actions":[{"handle":"setPage","displayName":"Set page","params":[{"handle":"page","displayName":"Page","defaultValue":"{{1}}"}]},{"handle":"selectRow","displayName":"Select row","params":[{"handle":"key","displayName":"Key"},{"handle":"value","displayName":"Value"}]},{"handle":"deselectRow","displayName":"Deselect row"},{"handle":"discardChanges","displayName":"Discard Changes"},{"handle":"discardNewlyAddedRows","displayName":"Discard newly added rows"},{"displayName":"Download table data","handle":"downloadTableData","params":[{"handle":"type","displayName":"Type","options":[{"name":"Download as Excel","value":"xlsx"},{"name":"Download as CSV","value":"csv"},{"name":"Download as PDF","value":"pdf"}],"defaultValue":"{{Download as Excel}}","type":"select"}]},{"handle":"selectAllRows","displayName":"Select all rows"},{"handle":"deselectAllRows","displayName":"Deselect all rows"},{"handle":"setFilters","displayName":"Set filters","params":[{"handle":"parameters","displayName":"Parameters"}]},{"handle":"clearFilters","displayName":"Clear filters"}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"title":{"value":"Table"},"visible":{"value":"{{true}}"},"loadingState":{"value":"{{false}}"},"useDynamicColumn":{"value":"{{true}}"},"columnData":{"value":"{{[{name: 'email', key: 'email', id: '1'}, {name: 'Full name', key: 'name', id: '2', isEditable: true}]}}"},"rowsPerPage":{"value":"{{10}}"},"serverSidePagination":{"value":"{{false}}"},"enableNextButton":{"value":"{{true}}"},"enablePrevButton":{"value":"{{true}}"},"totalRecords":{"value":"{{10}}"},"enablePagination":{"value":"{{true}}"},"serverSideSort":{"value":"{{false}}"},"serverSideFilter":{"value":"{{false}}"},"displaySearchBox":{"value":"{{true}}"},"showDownloadButton":{"value":"{{true}}"},"showFilterButton":{"value":"{{true}}"},"autogenerateColumns":{"value":true,"generateNestedColumns":true},"isAllColumnsEditable":{"value":"{{false}}"},"showBulkUpdateActions":{"value":"{{true}}"},"showBulkSelector":{"value":"{{false}}"},"highlightSelectedRow":{"value":"{{false}}"},"columnSizes":{"value":"{{({})}}"},"actions":{"value":[]},"enabledSort":{"value":"{{true}}"},"hideColumnSelectorButton":{"value":"{{false}}"},"defaultSelectedRow":{"value":"{{{"id":1}}}"},"showAddNewRowButton":{"value":"{{true}}"},"allowSelection":{"value":"{{true}}"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"}},"events":[],"styles":{"textColor":{"value":"#000"},"boxShadow":{"value":"0px 0px 0px 0px #00000090"}}}}}

- !Special comment for table

- The columnData property in table is used to set the columns of the table. The value of this property should be an array of objects and always should be wrapped in {{}} because it is a dynamic property.

Ex: {{[{name: 'email', key: 'email', id: '1'}, {name: 'Full name', key: 'name', id: '2', isEditable: true}]}}

- Ensure table data is never empty and always consumes data from a query (THIS IS A MANDATORY STEP)

  

### ToggleSwitch

{"toggleSwitchV2Config":{"name":"ToggleSwitch","defaultSize":{"width":6,"height":30},"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"properties":{"label":{"validation":{"schema":{"type":"string"}}},"defaultValue":{"validation":{"schema":{"type":"boolean"}},"options":[{"displayName":"On","value":"{{true}}"},{"displayName":"Off","value":"{{false}}"}]},"loadingState":{"validation":{"schema":{"type":"boolean"}}},"visibility":{"validation":{"schema":{"type":"boolean"}}},"disabledState":{"validation":{"schema":{"type":"boolean"}}},"tooltip":{"validation":{"schema":{"type":"string"}}}},"events":{"onChange":{"displayName":"On change"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box Shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]}},"accordian":"switch"}},"actions":[{"handle":"toggle","displayName":"toggle"},{"handle":"setValue","displayName":"Set value","params":[{"handle":"value","displayName":"value"}]},{"handle":"setVisibility","displayName":"Set visibility","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","displayName":"Set disable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setLoading","displayName":"Set loading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"validation":{"mandatory":{"value":"{{false}}"},"customRule":{"value":null}},"properties":{"label":{"value":"Label"},"defaultValue":{"value":"{{false}}"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"tooltip":{"value":""}},"events":[],"styles":{"boxShadow":{"value":"0px 0px 0px 0px #00000090"}}}}}

  

### VerticalDivider

{"verticalDividerConfig":{"name":"VerticalDivider","component":"VerticalDivider","defaultSize":{"width":2,"height":100},"properties":{},"events":{},"styles":{"dividerColor":{"type":"color","displayName":"Divider color","validation":{"schema":{"type":"string"},"defaultValue":"#000000"}},"visibility":{"type":"toggle","displayName":"Visibility","validation":{"schema":{"type":"boolean"},"defaultValue":true}}},"definition":{"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{},"events":[],"styles":{"visibility":{"value":"{{true}}"},"dividerColor":{"value":"#000000"}}}}}

  

### TextInput

{"textinputConfig":{"name":"TextInput","defaultSize":{"width":10,"height":40},"properties":{"label":{"validation":{"schema":{"type":"string"},"defaultValue":"Label"}},"placeholder":{"validation":{"schema":{"type":"string"},"defaultValue":"Enter your input"}},"value":{"validation":{"schema":{"type":"string"}}},"loadingState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"visibility":{"validation":{"schema":{"type":"boolean"},"defaultValue":true}},"disabledState":{"validation":{"schema":{"type":"boolean"},"defaultValue":false}},"tooltip":{"validation":{"schema":{"type":"string"},"defaultValue":"Tooltip text"}}},"validation":{"mandatory":{"type":"toggle","displayName":"Make this field mandatory"},"regex":{"type":"code","displayName":"Regex","placeholder":"^[a-zA-Z0-9_ -]{3,16}$"},"minLength":{"type":"code","displayName":"Min length","placeholder":"Enter min length"},"maxLength":{"type":"code","displayName":"Max length","placeholder":"Enter max length"},"customRule":{"type":"code","displayName":"Custom validation","placeholder":"{{components.text2.text=='yes'&&'valid'}}"}},"events":{"onChange":{"displayName":"On change"},"onEnterPressed":{"displayName":"On enter pressed"},"onFocus":{"displayName":"On focus"},"onBlur":{"displayName":"On blur"}},"styles":{"boxShadow":{"type":"boxShadow","displayName":"Box Shadow","validation":{"schema":{"type":"union","schemas":[{"type":"string"},{"type":"number"}]},"defaultValue":"0px 0px 0px 0px #00000040"},"accordian":"field"}},"exposedVariables":{"value":"","isMandatory":false,"isVisible":true,"isDisabled":false,"isLoading":false},"actions":[{"handle":"setText","displayName":"Set text","params":[{"handle":"text","displayName":"text","defaultValue":"New text"}]},{"handle":"clear","displayName":"Clear"},{"handle":"setFocus","displayName":"Set focus"},{"handle":"setBlur","displayName":"Set blur"},{"handle":"disable","displayName":"Disable(deprecated)","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"visibility","displayName":"Visibility(deprecated)","params":[{"handle":"visibility","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setVisibility","displayName":"Set visibility","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setDisable","displayName":"Set disable","params":[{"handle":"disable","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]},{"handle":"setLoading","displayName":"Set loading","params":[{"handle":"loading","displayName":"Value","defaultValue":"{{false}}","type":"toggle"}]}],"definition":{"validation":{"mandatory":{"value":"{{false}}"},"regex":{"value":""},"minLength":{"value":""},"maxLength":{"value":""},"customRule":{"value":""}},"others":{"showOnDesktop":{"value":"{{true}}"},"showOnMobile":{"value":"{{false}}"}},"properties":{"value":{"value":""},"label":{"value":"Label"},"placeholder":{"value":"Enter your input"},"visibility":{"value":"{{true}}"},"disabledState":{"value":"{{false}}"},"loadingState":{"value":"{{false}}"},"tooltip":{"value":""}},"events":[],"styles":{"textColor":{"value":"#1B1F24"},"borderColor":{"value":"#CCD1D5"},"accentColor":{"value":"#4368E3"},"errTextColor":{"value":"#D72D39"},"borderRadius":{"value":"{{6}}"},"backgroundColor":{"value":"#fff"},"iconColor":{"value":"#CFD3D859"},"direction":{"value":"left"},"width":{"value":"{{33}}"},"alignment":{"value":"side"},"color":{"value":"#1B1F24"},"auto":{"value":"{{true}}"},"padding":{"value":"default"},"boxShadow":{"value":"0px 0px 0px 0px #00000040"},"icon":{"value":"IconHome2"},"iconVisibility":{"value":false}}}}}

  
  

The component specifications are provided as reference to understand available properties, events, and styles for each component type. They describe the capabilities and constraints of each component in the ToolJet ecosystem.

  

## Events ruleset

Available event types

[

{

name: 'Show Alert',

id: 'show-alert',

options: [{ name: 'message', type: 'text', default: 'Message !' }],

},

{

name: 'Logout',

id: 'logout',

},

{

name: 'Run Query',

id: 'run-query',

options: [{ queryId: '' }],

},

{

name: 'Open Webpage',

id: 'open-webpage',

options: [{ name: 'url', type: 'text', default: 'https://example.com' }],

},

{

name: 'Go to app',

id: 'go-to-app',

options: [

{ name: 'app', type: 'text', default: '' },

{ name: 'queryParams', type: 'code', default: '[]' },

],

},

{

name: 'Show Modal',

id: 'show-modal',

options: [{ name: 'modal', type: 'text', default: '' }],

},

{

name: 'Close Modal',

id: 'close-modal',

options: [{ name: 'modal', type: 'text', default: '' }],

},

{

name: 'Copy to clipboard',

id: 'copy-to-clipboard',

options: [{ name: 'copy-to-clipboard', type: 'text', default: '' }],

},

{

name: 'Set local storage',

id: 'set-localstorage-value',

options: [

{ name: 'key', type: 'code', default: '' },

{ name: 'value', type: 'code', default: '' },

],

},

{

name: 'Generate file',

id: 'generate-file',

options: [

{ name: 'fileType', type: 'text', default: '' },

{ name: 'fileName', type: 'text', default: '' },

{ name: 'data', type: 'code', default: '{{[]}}' },

],

},

{

name: 'Set table page',

id: 'set-table-page',

options: [

{

name: 'table',

type: 'text',

default: '',

},

{ name: 'pageIndex', type: 'text', default: '{{1}}' },

],

},

{

name: 'Set variable',

id: 'set-custom-variable',

options: [

{ name: 'key', type: 'code', default: '' },

{ name: 'value', type: 'code', default: '' },

],

},

{

name: 'Unset variable',

id: 'unset-custom-variable',

options: [{ name: 'key', type: 'code', default: '' }],

},

{

name: 'Switch page',

id: 'switch-page',

options: [{ name: 'page', type: 'text', default: '' }],

},

{

name: 'Set page variable',

id: 'set-page-variable',

options: [

{ name: 'key', type: 'code', default: '' },

{ name: 'value', type: 'code', default: '' },

],

},

{

name: 'Unset page variable',

id: 'unset-page-variable',

options: [

{ name: 'key', type: 'code', default: '' },

{ name: 'value', type: 'code', default: '' },

],

},

{

name: 'Control component',

id: 'control-component',

options: [

{ name: 'component', type: 'text', default: '' },

{ name: 'action', type: 'text', default: '' },

],

},

];

  

-In the component definition provided above, there is a section called events. This section contains a list of actions that are supported on the components or component specific actions. These actions can be triggered either from a runjs query using

components.component_name.componentSpecificAction() or from any component the control-component event can be used to trigger a csa.

Ex :

{"modal": "modal_name", "eventId": "onClick", "message": "Hello world!", "actionId": "show-modal", "alertType": "info", "runOnlyIf": ""}

This is an event attached to a button component which opens a modal.

This can also be done by control component like

{"eventId": "onClick", "message": "Hello world!", "actionId": "control-component", "alertType": "info", "componentId": "component_name", "componentSpecificActionHandle": "open", "componentSpecificActionParams": []}

If you are generating a event for control component, all the params are mandatory. The componentId is the name of the component and the componentSpecificActionHandle is the action that you want to perform on the component. The componentSpecificActionParams are the params that you want to pass to the action.`;
