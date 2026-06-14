const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Agente HTTPS para ignorar erros de handshake TLS/SSL se houver
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body; // Mantido o padrão 'user' que seu front já envia

    try {
        // 1. LOGIN SED [LOG #2]
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY
            }}
        );

        const tokenSed = loginRes.data.token;
        const cdUsuario9 = loginRes.data.DadosUsuario.CD_USUARIO.toString();
        // TRUNCAGEM CRÍTICA: A SED usa 8 dígitos para turmas/notas [LOG #3, #28]
        const cdUsuario8 = cdUsuario9.substring(0, 8);

        // 2. BUSCAR TURMA (Início do fluxo de dados) [LOG #3]
        const turmaRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY
            }
        });

        // Tratativa preventiva para ler a turma se vier como array ou objeto com .data
        const infoTurma = Array.isArray(turmaRes.data) ? turmaRes.data[0] : (turmaRes.data.data || {});
        const escolaId = infoTurma.CodigoEscola || 0;

        // 3. HANDSHAKE IP.TV - RESOLVE O ERRO 404 [LOG #5]
        const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
            { token: tokenSed },
            {
                httpsAgent,
                headers: {
                    'Host': 'edusp', // Força o Virtual Host para evitar 404
                    'x-api-realm': 'edusp',
                    'x-api-platform': 'webclient',
                    'Content-Type': 'application/json'
                }
            }
        );

        const authTokenIptv = iptvHandshake.data.auth_token;

        // 4. BUSCAR AVALIAÇÕES [LOG #28]
        let totalAvaliacoes = 0;
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, {
                headers: {
                    'Authorization': `Bearer ${tokenSed}`,
                    'X-Product-Name': CONSTANTS.PRODUCT,
                    'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY
                }
            });
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            totalAvaliacoes = listaAvaliacoes.length;
        } catch (errAval) {
            console.error("Erro na rota de avaliações (ignorado):", errAval.message);
        }

        // 5. BUSCAR TAREFAS NA IP.TV [LOG #24]
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        try {
            const tasksRes = await axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo/count?filter_expired=true&publication_target=vialv`, {
                httpsAgent,
                headers: { 
                    'x-api-key': authTokenIptv, 
                    'Host': 'edusp' 
                }
            });
            tarefasPendentes = tasksRes.data.todo || 0;
            tarefasExpiradas = tasksRes.data.expired || 0;
        } catch (errTasks) {
            console.error("Erro na rota de tarefas IPTV (ignorado):", errTasks.message);
        }

        // RESPOSTA UNIFICADA COMPATÍVEL COM O SEU DASHBOARD
        res.json({
            aluno: {
                codigo: cdUsuario8,
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: 0
            }
        });

    } catch (error) {
        console.error("Erro no Fluxo Principal do BFF:", error.response ? error.response.status : error.message);
        res.status(error.response ? error.response.status : 500).json({
            error: "Falha na integração com os servidores governamentais.",
            details: error.response ? error.response.data : error.message
        });
    }
});

const PORT = process.env.PORT || 10000; // Mantida a porta do Render
app.listen(PORT, () => console.log(`BFF Sala do Futuro homologado rodando na porta ${PORT}`));
