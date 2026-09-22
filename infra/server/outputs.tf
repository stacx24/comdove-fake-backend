output "url" {
  description = "Public address (UI at /client and /admin, Meta API at /v…/)."
  value       = "https://${aws_route53_record.server.fqdn}"
}

output "comdove_meta_graph_api_base_url" {
  description = "Set this as META_GRAPH_API_BASE_URL in the ComDove backend that should use the mock."
  value       = "https://${aws_route53_record.server.fqdn}"
}

output "instance_id" {
  description = "For status / logs: aws ssm start-session --target <id>."
  value       = aws_instance.server.id
}

output "public_ip" {
  value = aws_instance.server.public_ip
}
