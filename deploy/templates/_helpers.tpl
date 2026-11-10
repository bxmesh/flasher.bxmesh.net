{{- define "flasher.labels" -}}
app.kubernetes.io/name: flasher
app.kubernetes.io/part-of: flasher.bxmesh.net
{{- end }}

{{- define "flasher.selector" -}}
app.kubernetes.io/name: flasher
{{- end }}

{{- define "flasher.image" -}}
{{ .Values.image.repository }}:{{ required "image.tag is written by CI" .Values.image.tag }}
{{- end }}
