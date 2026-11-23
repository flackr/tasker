function TasksSettings() {
  return (
    <Page>
      <Section title="Nextcloud Connection">
        <TextInput
          label="Nextcloud Server URL"
          placeholder="https://your-nextcloud-server.com"
          settingsKey="app_server"
        />
        <TextInput
          label="Username"
          placeholder="username"
          settingsKey="app_username"
        />
        <TextInput
          label="App Password"
          placeholder="Paste your Nextcloud app password here"
          settingsKey="app_password"
        />
      </Section>
      <Section title="Task Lists &amp; Categories">
        <TextInput
          label="Task List Name (optional)"
          placeholder="shopping (leave blank to auto-detect)"
          settingsKey="app_calendar"
        />
        <TextInput
          label="Config JSON Path (optional)"
          placeholder="Notes/tasker-config.json"
          settingsKey="app_config_path"
        />
        <Text>To get an app password:</Text>
        <Text>1. Open your Nextcloud website.</Text>
        <Text>2. Navigate to Personal &gt; Security.</Text>
        <Text>3. Create a new app password.</Text>
        <Text>4. Paste the generated app password into the input field above.</Text>
      </Section>
    </Page>
  );
}

registerSettingsPage(TasksSettings);
